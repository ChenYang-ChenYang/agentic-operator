import { createHash, randomUUID } from "node:crypto";
import {
  and,
  desc,
  eq,
  factoryToolRevisions,
  factoryTools,
  getDb,
  tenants,
} from "@agentic/db";
import { lt, or } from "drizzle-orm";
import {
  findSensitiveInputPath,
  isGeneratedToolExecutionPolicy,
  parseCapabilityDescriptors,
  persistedToolAsRealTool,
  validateDeclarativeExamplesAgainstContract,
  validateDeclarativeToolPolicy,
  type DeclarativeTool,
} from "@agentic/agent-factory";
import { globalToolRegistry, makeDeclarativeTool } from "@agentic/tools";
import { stableJson } from "@agentic/shared/cassette";
import { hasFactoryActiveWork } from "./active-work";
import { type GlobalToolProbeReceipt } from "./tool-probe-store";
import {
  verifyToolRevisionActivationEvidence,
} from "./production-integration-probe-gate";

type RevisionRow = typeof factoryToolRevisions.$inferSelect;
type ToolRow = typeof factoryTools.$inferSelect;

export type ToolRevisionStatus = "draft" | "active" | "retired" | "rejected";
export type ToolRevisionSource = "ontocode" | "manual" | "api_import";

export interface ToolStaticValidationReceipt {
  schema: "factory-tool-static-validation/v1";
  passed: boolean;
  checks: string[];
  issues: string[];
  validatedAt: string;
}

export interface ManagedToolRevision {
  id: string;
  tenantId: string;
  domainId: string | null;
  name: string;
  version: number;
  status: ToolRevisionStatus;
  definitionHash: string;
  definition: DeclarativeTool;
  validation: ToolStaticValidationReceipt;
  source: ToolRevisionSource;
  createdBy: string;
  reviewedBy?: string;
  reviewedAt?: string;
  activatedAt?: string;
  retiredAt?: string;
  activationProbeHash?: string;
  activationEvidence?: Record<string, unknown>;
  supersedesRevisionId?: string;
  activation: {
    eligible: boolean;
    blockers: Array<{
      code: "managed_write_probe_lifecycle_unavailable";
      message: string;
      next: "fde_register_code_owned_write_lifecycle";
    }>;
  };
  createdAt: string;
  updatedAt: string;
}

export class ToolRevisionError extends Error {
  constructor(
    readonly code:
      | "INVALID_TOOL_DRAFT"
      | "TOOL_NAME_COLLISION"
      | "TOOL_REVISION_NOT_FOUND"
      | "TOOL_REVISION_NOT_ACTIVATABLE"
      | "TOOL_REVISION_CONFLICT"
      | "INVALID_TOOL_REVISION_CURSOR"
      | "TOOL_REVISION_PROBE_REQUIRED"
      | "TOOL_REVISION_EVIDENCE_INVALID"
      | "TOOL_REVISION_WRITE_PROOF_REQUIRED"
      | "TOOL_REVISION_WRITE_LIFECYCLE_UNAVAILABLE"
      | "TOOL_REVISION_NOT_ACTIVE"
      | "FACTORY_EXECUTION_ACTIVE",
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = "ToolRevisionError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function definitionProjection(tool: DeclarativeTool): DeclarativeTool {
  return {
    name: tool.name.trim(),
    description: tool.description.trim(),
    method: tool.method.trim().toUpperCase(),
    urlTemplate: tool.urlTemplate.trim(),
    ...(tool.headers ? { headers: tool.headers } : {}),
    ...(tool.bodyTemplate ? { bodyTemplate: tool.bodyTemplate } : {}),
    ...(tool.requestSpec ? { requestSpec: tool.requestSpec } : {}),
    ...(tool.responseSpec ? { responseSpec: tool.responseSpec } : {}),
    ...(tool.examples ? { examples: tool.examples } : {}),
    sideEffect: tool.sideEffect,
    operation: tool.operation,
    effectScope: tool.effectScope,
    sandboxPolicy: tool.sandboxPolicy,
    domain: tool.domain ?? null,
    ...(tool.paramsSchema ? { paramsSchema: tool.paramsSchema } : {}),
    ...(tool.returnsSchema ? { returnsSchema: tool.returnsSchema } : {}),
    ...(tool.capabilities ? { capabilities: tool.capabilities } : {}),
    ...(tool.probeSafety ? { probeSafety: tool.probeSafety } : {}),
    probeStatus: "required",
  };
}

function revisionDefinitionHash(tool: DeclarativeTool): string {
  return createHash("sha256")
    .update(
      stableJson({
        schema: "factory-tool-revision-definition/v1",
        definition: definitionProjection(tool),
      }),
    )
    .digest("hex");
}

function factoryRowDefinition(row: ToolRow): DeclarativeTool {
  return {
    name: row.name,
    description: row.description,
    method: row.method,
    urlTemplate: row.urlTemplate,
    headers: (row.headers as Record<string, string>) ?? undefined,
    bodyTemplate: row.bodyTemplate ?? undefined,
    requestSpec:
      (row.requestSpec as DeclarativeTool["requestSpec"]) ?? undefined,
    responseSpec:
      (row.responseSpec as DeclarativeTool["responseSpec"]) ?? undefined,
    examples: (row.examples as DeclarativeTool["examples"]) ?? undefined,
    sideEffect: row.sideEffect,
    operation: row.operation as DeclarativeTool["operation"],
    effectScope: row.effectScope as DeclarativeTool["effectScope"],
    sandboxPolicy: row.sandboxPolicy as DeclarativeTool["sandboxPolicy"],
    domain: row.domain,
    paramsSchema:
      (row.paramsSchema as Record<string, unknown>) ?? undefined,
    returnsSchema:
      (row.returnsSchema as Record<string, unknown>) ?? undefined,
    capabilities:
      (row.capabilities as DeclarativeTool["capabilities"]) ?? undefined,
    probeSafety:
      (row as ToolRow & { probeSafety?: DeclarativeTool["probeSafety"] })
        .probeSafety ?? undefined,
    probeStatus:
      row.probeStatus === "verified" || row.probeStatus === "failed"
        ? row.probeStatus
        : "required",
  };
}

function managedActivationAssessment(
  tool: DeclarativeTool,
): ManagedToolRevision["activation"] {
  const writeCapable =
    tool.sideEffect === "write" ||
    tool.sideEffect === "dual" ||
    tool.operation === "write" ||
    tool.operation === "read_write";
  const blockers: ManagedToolRevision["activation"]["blockers"] =
    writeCapable
      ? [
          {
            code: "managed_write_probe_lifecycle_unavailable",
            message:
              "声明式 managed tool 目前没有可审计的 code-owned canary cleanup/readback lifecycle；它可以保留为草稿，但不能 probe 或激活。",
            next: "fde_register_code_owned_write_lifecycle",
          },
        ]
      : [];
  return { eligible: blockers.length === 0, blockers };
}

/** Independent validation boundary for every managed draft. Model-facing
 * schemas are hints; this receipt is produced only by deterministic code. */
export function validateManagedToolDraft(
  candidate: DeclarativeTool,
): {
  tool: DeclarativeTool;
  definitionHash: string;
  receipt: ToolStaticValidationReceipt;
} {
  const tool = definitionProjection(candidate);
  const issues: string[] = [];
  const checks: string[] = [];
  const pass = (check: string) => checks.push(check);

  if (
    !/^[A-Za-z][A-Za-z0-9_-]*(?:\.[A-Za-z][A-Za-z0-9_-]*)+$/.test(tool.name)
  ) {
    issues.push("工具名必须带命名空间，例如 gohire.generateJobDescription");
  } else {
    pass("namespaced_name");
  }
  if (!tool.description || tool.description.length > 2_000) {
    issues.push("description 必须为 1..2000 字符");
  } else {
    pass("bounded_description");
  }
  if (!new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]).has(tool.method)) {
    issues.push("method 必须是 GET/HEAD/POST/PUT/PATCH/DELETE");
  } else {
    pass("supported_http_method");
  }
  try {
    const parsed = new URL(tool.urlTemplate);
    if (
      !new Set(["http:", "https:"]).has(parsed.protocol) ||
      parsed.username ||
      parsed.password
    ) {
      issues.push("urlTemplate 必须是不含用户名/密码的绝对 http(s) URL");
    } else {
      pass("absolute_secret_free_url");
    }
  } catch {
    issues.push("urlTemplate 必须是绝对 http(s) URL");
  }
  const literalSecret = findSensitiveInputPath(
    {
      url_template: tool.urlTemplate,
      headers: tool.headers,
      body_template: tool.bodyTemplate,
      examples: tool.examples,
    },
    "tool",
  );
  if (literalSecret) {
    issues.push(`${literalSecret} 含字面凭证；只能使用配置占位符`);
  } else {
    pass("no_literal_secret");
  }
  const capabilities = parseCapabilityDescriptors(tool.capabilities);
  if (!capabilities.ok || capabilities.capabilities.length === 0) {
    issues.push(
      capabilities.ok
        ? "外部工具至少需要一条精确 capability 声明"
        : capabilities.error,
    );
  } else {
    tool.capabilities = capabilities.capabilities;
    pass("typed_capabilities");
  }
  if (!isRecord(tool.paramsSchema) || Object.keys(tool.paramsSchema).length === 0) {
    issues.push("paramsSchema 必须是非空对象");
  } else {
    pass("typed_input_contract");
  }
  if (
    !isRecord(tool.returnsSchema) ||
    Object.keys(tool.returnsSchema).length === 0
  ) {
    issues.push("returnsSchema 必须是非空对象");
  } else {
    pass("typed_output_contract");
  }
  const sideEffect = validateDeclarativeToolPolicy({
    method: tool.method,
    declaredSideEffect: tool.sideEffect,
    bodyTemplate: tool.bodyTemplate,
    requestSpec: tool.requestSpec,
    capabilities: tool.capabilities,
  });
  if (!sideEffect.ok) {
    issues.push(sideEffect.error);
  } else {
    tool.sideEffect = sideEffect.sideEffect;
    pass("reviewed_side_effect");
  }
  if (
    !isGeneratedToolExecutionPolicy(tool) ||
    tool.effectScope !== "external"
  ) {
    issues.push(
      "operation/effectScope=external/sandboxPolicy 必须构成完整执行策略",
    );
  } else {
    pass("reviewed_execution_policy");
  }
  if (tool.examples?.length) {
    const examples = validateDeclarativeExamplesAgainstContract({
      requestSpec: tool.requestSpec,
      responseSpec: tool.responseSpec,
      examples: tool.examples,
    });
    if (!examples.ok) {
      issues.push(...examples.errors.slice(0, 10));
    } else {
      pass("examples_reconcile");
    }
  }
  if (issues.length === 0) {
    try {
      // Construction performs the same manifest/policy validation the runtime
      // uses, but does not execute or contact the declared endpoint.
      makeDeclarativeTool(tool);
      pass("runtime_descriptor_constructible");
    } catch (error) {
      issues.push((error as Error).message);
    }
  }
  const receipt: ToolStaticValidationReceipt = {
    schema: "factory-tool-static-validation/v1",
    passed: issues.length === 0,
    checks,
    issues,
    validatedAt: new Date().toISOString(),
  };
  if (!receipt.passed) {
    throw new ToolRevisionError(
      "INVALID_TOOL_DRAFT",
      `工具草稿未通过静态验证：${issues.join("；")}`,
      400,
    );
  }
  return {
    tool,
    definitionHash: revisionDefinitionHash(tool),
    receipt,
  };
}

function rowToRevision(row: RevisionRow): ManagedToolRevision {
  return {
    id: row.id,
    tenantId: row.tenantId,
    domainId: row.domainKey || null,
    name: row.name,
    version: row.version,
    status: row.status,
    definitionHash: row.definitionHash,
    definition: row.definitionJson as unknown as DeclarativeTool,
    validation: row.validationJson as unknown as ToolStaticValidationReceipt,
    source: row.source,
    createdBy: row.createdBy,
    ...(row.reviewedBy ? { reviewedBy: row.reviewedBy } : {}),
    ...(row.reviewedAt
      ? { reviewedAt: row.reviewedAt.toISOString() }
      : {}),
    ...(row.activatedAt
      ? { activatedAt: row.activatedAt.toISOString() }
      : {}),
    ...(row.retiredAt ? { retiredAt: row.retiredAt.toISOString() } : {}),
    ...(row.activationProbeHash
      ? { activationProbeHash: row.activationProbeHash }
      : {}),
    ...(row.activationEvidenceJson
      ? {
          activationEvidence:
            row.activationEvidenceJson as Record<string, unknown>,
        }
      : {}),
    ...(row.supersedesRevisionId
      ? { supersedesRevisionId: row.supersedesRevisionId }
      : {}),
    activation: managedActivationAssessment(
      row.definitionJson as unknown as DeclarativeTool,
    ),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function scopeWhere(input: {
  tenantId: string;
  domainId?: string | null;
  name?: string;
}) {
  const predicates = [
    eq(factoryToolRevisions.tenantId, input.tenantId),
    eq(
      factoryToolRevisions.domainKey,
      input.domainId?.trim() || "__unbound__",
    ),
  ];
  if (input.name) predicates.push(eq(factoryToolRevisions.name, input.name));
  return and(...predicates)!;
}

function importActiveProjectionIfNeeded(input: {
  tenantId: string;
  domainId?: string | null;
  name: string;
  actor: string;
}): void {
  const existingRevisions = getDb()
    .select({ id: factoryToolRevisions.id })
    .from(factoryToolRevisions)
    .where(scopeWhere(input))
    .all();
  if (existingRevisions.length > 0) return;
  const active = getDb()
    .select()
    .from(factoryTools)
    .where(
      and(
        eq(factoryTools.scopeKey, input.tenantId),
        eq(
          factoryTools.domainKey,
          !input.domainId || input.domainId === "__unbound__"
            ? ""
            : input.domainId,
        ),
        eq(factoryTools.name, input.name),
      ),
    )
    .get();
  if (!active) return;
  const definition = factoryRowDefinition(active);
  let validated:
    | ReturnType<typeof validateManagedToolDraft>
    | undefined;
  let validation: ToolStaticValidationReceipt;
  try {
    validated = validateManagedToolDraft(definition);
    validation = validated.receipt;
  } catch (error) {
    validation = {
      schema: "factory-tool-static-validation/v1",
      passed: false,
      checks: ["legacy_active_projection_imported_without_policy_inference"],
      issues: [(error as Error).message],
      validatedAt: new Date().toISOString(),
    };
  }
  const now = new Date();
  getDb()
    .insert(factoryToolRevisions)
    .values({
      id: `tvr-${randomUUID()}`,
      tenantId: input.tenantId,
      domainKey: input.domainId?.trim() || "__unbound__",
      name: active.name,
      version: 1,
      status: "active",
      definitionJson: definition as unknown as Record<string, unknown>,
      definitionHash:
        validated?.definitionHash ??
        revisionDefinitionHash(definition),
      validationJson: validation as unknown as Record<string, unknown>,
      source: "manual",
      createdBy: "legacy-active-import",
      reviewedBy: input.actor,
      reviewedAt: now,
      activatedAt: active.createdAt,
      activationProbeHash: active.definitionHash,
      activationEvidenceJson:
        (active.probeEvidence as Record<string, unknown>) ?? null,
      createdAt: active.createdAt,
      updatedAt: now,
    })
    .run();
}

export function createToolDraft(input: {
  tenantId: string;
  domainId?: string | null;
  tool: DeclarativeTool;
  actor?: string;
  source?: ToolRevisionSource;
}): ManagedToolRevision {
  if (globalToolRegistry.has(input.tool.name)) {
    throw new ToolRevisionError(
      "TOOL_NAME_COLLISION",
      `「${input.tool.name}」与内置全局工具同名；生成工具不能覆盖全局库`,
      409,
    );
  }
  const actor = input.actor?.trim() || "ontocode";
  const validated = validateManagedToolDraft({
    ...input.tool,
    domain:
      input.tool.domain ??
      (input.domainId === "__unbound__" ? null : input.domainId ?? null),
  });
  importActiveProjectionIfNeeded({
    tenantId: input.tenantId,
    domainId: input.domainId,
    name: validated.tool.name,
    actor,
  });
  const scope = scopeWhere({
    tenantId: input.tenantId,
    domainId: input.domainId,
    name: validated.tool.name,
  });
  // Allocate version and insert under one database write transaction. The
  // unique scope/version index remains the cross-process backstop.
  return getDb().transaction((tx) => {
    const rows = tx
      .select()
      .from(factoryToolRevisions)
      .where(scope)
      .orderBy(desc(factoryToolRevisions.version))
      .all();
    const same = rows.find(
      (row) => row.definitionHash === validated.definitionHash,
    );
    if (same) return rowToRevision(same);
    const now = new Date();
    const previous = rows[0];
    const id = `tvr-${randomUUID()}`;
    tx
      .insert(factoryToolRevisions)
      .values({
        id,
        tenantId: input.tenantId,
        domainKey: input.domainId?.trim() || "__unbound__",
        name: validated.tool.name,
        version: (previous?.version ?? 0) + 1,
        status: "draft",
        definitionJson:
          validated.tool as unknown as Record<string, unknown>,
        definitionHash: validated.definitionHash,
        validationJson:
          validated.receipt as unknown as Record<string, unknown>,
        source: input.source ?? "ontocode",
        createdBy: actor,
        supersedesRevisionId: previous?.id ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    return rowToRevision(
      tx
        .select()
        .from(factoryToolRevisions)
        .where(eq(factoryToolRevisions.id, id))
        .get()!,
    );
  });
}

export function listToolRevisions(input: {
  tenantId: string;
  domainId?: string | null;
  name?: string;
}): ManagedToolRevision[] {
  return getDb()
    .select()
    .from(factoryToolRevisions)
    .where(scopeWhere(input))
    .orderBy(
      desc(factoryToolRevisions.createdAt),
      desc(factoryToolRevisions.id),
    )
    .all()
    .map(rowToRevision);
}

export function listToolRevisionPage(input: {
  tenantId: string;
  domainId?: string | null;
  name?: string;
  status?: ToolRevisionStatus;
  limit?: number;
  cursor?: string;
}): {
  revisions: ManagedToolRevision[];
  nextCursor?: string;
} {
  const limit = Math.max(1, Math.min(100, Math.floor(input.limit ?? 25)));
  let cursor: { createdAt: string; id: string } | undefined;
  if (input.cursor) {
    try {
      const parsed = JSON.parse(
        Buffer.from(input.cursor, "base64url").toString("utf8"),
      ) as { createdAt?: unknown; id?: unknown };
      if (
        typeof parsed.createdAt !== "string" ||
        !Number.isFinite(Date.parse(parsed.createdAt)) ||
        typeof parsed.id !== "string" ||
        !parsed.id
      ) {
        throw new Error("invalid cursor");
      }
      cursor = { createdAt: parsed.createdAt, id: parsed.id };
    } catch {
      throw new ToolRevisionError(
        "INVALID_TOOL_REVISION_CURSOR",
        "工具 revision cursor 无效",
        400,
      );
    }
  }
  const predicates = [
    eq(factoryToolRevisions.tenantId, input.tenantId),
    eq(
      factoryToolRevisions.domainKey,
      input.domainId?.trim() || "__unbound__",
    ),
  ];
  if (input.name) predicates.push(eq(factoryToolRevisions.name, input.name));
  if (input.status) {
    predicates.push(eq(factoryToolRevisions.status, input.status));
  }
  if (cursor) {
    const cursorAt = new Date(cursor.createdAt);
    predicates.push(
      or(
        lt(factoryToolRevisions.createdAt, cursorAt),
        and(
          eq(factoryToolRevisions.createdAt, cursorAt),
          lt(factoryToolRevisions.id, cursor.id),
        ),
      )!,
    );
  }
  const rows = getDb()
    .select()
    .from(factoryToolRevisions)
    .where(and(...predicates))
    .orderBy(
      desc(factoryToolRevisions.createdAt),
      desc(factoryToolRevisions.id),
    )
    .limit(limit + 1)
    .all();
  const hasMore = rows.length > limit;
  const revisions = rows.slice(0, limit).map(rowToRevision);
  const last = revisions.at(-1);
  return {
    revisions,
    ...(hasMore && last
      ? {
          nextCursor: Buffer.from(
            JSON.stringify({ createdAt: last.createdAt, id: last.id }),
            "utf8",
          ).toString("base64url"),
        }
      : {}),
  };
}

export function getToolRevision(input: {
  tenantId: string;
  domainId?: string | null;
  revisionId: string;
  name?: string;
}): ManagedToolRevision | undefined {
  const row = getDb()
    .select()
    .from(factoryToolRevisions)
    .where(
      and(
        scopeWhere(input),
        eq(factoryToolRevisions.id, input.revisionId),
      ),
    )
    .get();
  return row ? rowToRevision(row) : undefined;
}

function toolProjectionColumns(
  tool: DeclarativeTool,
  receipt: GlobalToolProbeReceipt,
) {
  return {
    description: tool.description,
    method: tool.method,
    urlTemplate: tool.urlTemplate,
    headers: tool.headers ?? null,
    bodyTemplate: tool.bodyTemplate ?? null,
    requestSpec: tool.requestSpec ?? null,
    responseSpec: tool.responseSpec ?? null,
    examples: tool.examples ?? null,
    sideEffect: tool.sideEffect,
    operation: tool.operation,
    effectScope: tool.effectScope,
    sandboxPolicy: tool.sandboxPolicy,
    domain: tool.domain,
    paramsSchema: tool.paramsSchema ?? null,
    returnsSchema: tool.returnsSchema ?? null,
    capabilities: tool.capabilities ?? null,
    probeStatus: "verified",
    definitionHash: receipt.definitionHash,
    probeEvidence: receipt.evidence ?? null,
    verifiedAt: receipt.verifiedAt ? new Date(receipt.verifiedAt) : null,
  } as const;
}

/** Activate a draft or retired revision. This is the only managed path that
 * mutates the runtime-visible factory_tools projection. */
export async function activateToolRevision(input: {
  tenantId: string;
  domainId?: string | null;
  revisionId: string;
  actor: string;
  /** Optimistic concurrency guard. null means the reviewer observed no active
   * managed revision; a string must be the exact currently-active revision. */
  expectedActiveRevisionId: string | null;
}): Promise<ManagedToolRevision> {
  const actor = input.actor.trim();
  if (!actor) {
    throw new ToolRevisionError(
      "TOOL_REVISION_NOT_ACTIVATABLE",
      "激活工具需要可审计的登录用户身份",
      403,
    );
  }
  if (hasFactoryActiveWork(input.tenantId)) {
    throw new ToolRevisionError(
      "FACTORY_EXECUTION_ACTIVE",
      "Factory 正在使用当前工具快照；本轮结束前不能激活或回滚工具",
      409,
    );
  }
  const revision = getToolRevision(input);
  if (!revision) {
    throw new ToolRevisionError(
      "TOOL_REVISION_NOT_FOUND",
      "没有这个 tenant/domain 下的工具 revision",
      404,
    );
  }
  if (
    revision.status === "rejected" ||
    revision.status === "active" ||
    !revision.validation.passed
  ) {
    throw new ToolRevisionError(
      "TOOL_REVISION_NOT_ACTIVATABLE",
      `revision 状态 ${revision.status} 不能激活`,
      409,
    );
  }
  if (!revision.activation.eligible) {
    throw new ToolRevisionError(
      "TOOL_REVISION_WRITE_LIFECYCLE_UNAVAILABLE",
      revision.activation.blockers[0]!.message,
      409,
    );
  }
  // Re-run static validation so stored JSON corruption or validator drift is
  // caught before the active projection changes.
  const current = validateManagedToolDraft(revision.definition);
  if (current.definitionHash !== revision.definitionHash) {
    throw new ToolRevisionError(
      "TOOL_REVISION_NOT_ACTIVATABLE",
      "revision definition hash 已漂移，不能激活",
      409,
    );
  }
  const tenant = getDb()
    .select({ slug: tenants.slug })
    .from(tenants)
    .where(eq(tenants.id, input.tenantId))
    .get();
  if (!tenant) {
    throw new ToolRevisionError(
      "TOOL_REVISION_NOT_FOUND",
      "工具 revision 的 tenant 已不存在",
      404,
    );
  }
  const evidence = await verifyToolRevisionActivationEvidence({
    tenantId: input.tenantId,
    tenantSlug: tenant.slug,
    domainId: input.domainId?.trim() || "__unbound__",
    revisionId: revision.id,
    revisionDefinitionHash: revision.definitionHash,
    tool: persistedToolAsRealTool(revision.definition),
  });
  if (!evidence.ok) {
    if (evidence.code === "production_live_probe_missing") {
      throw new ToolRevisionError(
        "TOOL_REVISION_PROBE_REQUIRED",
        evidence.message,
        428,
      );
    }
    if (evidence.code === "production_write_probe_incomplete") {
      throw new ToolRevisionError(
        "TOOL_REVISION_WRITE_PROOF_REQUIRED",
        evidence.message,
        428,
      );
    }
    throw new ToolRevisionError(
      "TOOL_REVISION_EVIDENCE_INVALID",
      evidence.message,
      428,
    );
  }
  const receipt = evidence.receipt;
  const now = new Date();
  const db = getDb();
  const projectionDomainKey =
    input.domainId === "__unbound__" ? "" : input.domainId ?? "";
  db.transaction((tx) => {
    const currentRevision = tx
      .select()
      .from(factoryToolRevisions)
      .where(
        and(
          scopeWhere({
            tenantId: input.tenantId,
            domainId: input.domainId,
            name: revision.name,
          }),
          eq(factoryToolRevisions.id, revision.id),
        ),
      )
      .get();
    if (
      !currentRevision ||
      currentRevision.definitionHash !== revision.definitionHash ||
      currentRevision.status !== revision.status ||
      (currentRevision.status !== "draft" &&
        currentRevision.status !== "retired")
    ) {
      throw new ToolRevisionError(
        "TOOL_REVISION_CONFLICT",
        "revision 在证据核验期间已变化；本次激活未生效，请刷新后重试",
        409,
      );
    }
    const observedActive = tx
      .select({
        id: factoryToolRevisions.id,
        activationProbeHash: factoryToolRevisions.activationProbeHash,
      })
      .from(factoryToolRevisions)
      .where(
        and(
          scopeWhere({
            tenantId: input.tenantId,
            domainId: input.domainId,
            name: revision.name,
          }),
          eq(factoryToolRevisions.status, "active"),
        ),
      )
      .get();
    if ((observedActive?.id ?? null) !== input.expectedActiveRevisionId) {
      throw new ToolRevisionError(
        "TOOL_REVISION_CONFLICT",
        `active revision 已变化（expected=${input.expectedActiveRevisionId ?? "none"}, current=${observedActive?.id ?? "none"}）；请刷新后重新确认`,
        409,
      );
    }
    const observedProjection = tx
      .select({ definitionHash: factoryTools.definitionHash })
      .from(factoryTools)
      .where(
        and(
          eq(factoryTools.scopeKey, input.tenantId),
          eq(factoryTools.domainKey, projectionDomainKey),
          eq(factoryTools.name, revision.name),
        ),
      )
      .get();
    if (observedActive) {
      if (
        !observedActive.activationProbeHash ||
        !observedProjection ||
        observedProjection.definitionHash !==
          observedActive.activationProbeHash
      ) {
        throw new ToolRevisionError(
          "TOOL_REVISION_CONFLICT",
          "runtime projection 与已审核 active revision 的 probe receipt 已漂移；不会覆盖，需先修复 ledger/projection 一致性",
          409,
        );
      }
    } else if (observedProjection) {
      throw new ToolRevisionError(
        "TOOL_REVISION_CONFLICT",
        "检测到没有 managed active revision 的 legacy/runtime projection；不会静默覆盖，请先完成显式 lifecycle migration",
        409,
      );
    }
    const retired = tx
      .update(factoryToolRevisions)
      .set({ status: "retired", retiredAt: now, updatedAt: now })
      .where(
        and(
          scopeWhere({
            tenantId: input.tenantId,
            domainId: input.domainId,
            name: revision.name,
          }),
          eq(factoryToolRevisions.status, "active"),
        ),
      )
      .run();
    if (
      input.expectedActiveRevisionId !== null &&
      (retired as { changes?: number }).changes !== 1
    ) {
      throw new ToolRevisionError(
        "TOOL_REVISION_CONFLICT",
        "旧 active revision 未能按预期 retire；本次激活已回滚",
        409,
      );
    }
    tx
      .insert(factoryTools)
      .values({
        id: `tol-${randomUUID()}`,
        scopeKey: input.tenantId,
        domainKey: projectionDomainKey,
        tenantId: input.tenantId,
        name: revision.name,
        ...toolProjectionColumns(revision.definition, receipt),
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          factoryTools.scopeKey,
          factoryTools.domainKey,
          factoryTools.name,
        ],
        set: {
          ...toolProjectionColumns(revision.definition, receipt),
          updatedAt: now,
        },
      })
      .run();
    const activated = tx
      .update(factoryToolRevisions)
      .set({
        status: "active",
        reviewedBy: actor,
        reviewedAt: now,
        activatedAt: now,
        retiredAt: null,
        activationProbeHash: receipt.definitionHash,
        activationEvidenceJson: {
          evidenceMode: receipt.evidence?.evidenceMode,
          attestationKeyId: evidence.attestationKeyId,
          attestationExpiresAt: evidence.attestationExpiresAt,
          verifiedAt: receipt.verifiedAt,
        },
        updatedAt: now,
      })
      .where(
        and(
          scopeWhere({
            tenantId: input.tenantId,
            domainId: input.domainId,
            name: revision.name,
          }),
          eq(factoryToolRevisions.id, revision.id),
          eq(factoryToolRevisions.definitionHash, revision.definitionHash),
          eq(factoryToolRevisions.status, revision.status),
        ),
      )
      .run();
    if ((activated as { changes?: number }).changes !== 1) {
      throw new ToolRevisionError(
        "TOOL_REVISION_CONFLICT",
        "revision 激活 CAS 失败；projection 与 ledger 事务已回滚",
        409,
      );
    }
  });
  return getToolRevision(input)!;
}

export function rejectToolRevision(input: {
  tenantId: string;
  domainId?: string | null;
  revisionId: string;
  actor: string;
}): ManagedToolRevision {
  const actor = input.actor.trim();
  if (!actor) {
    throw new ToolRevisionError(
      "TOOL_REVISION_NOT_ACTIVATABLE",
      "拒绝工具草稿需要可审计的登录用户身份",
      403,
    );
  }
  getDb().transaction((tx) => {
    const revision = tx
      .select()
      .from(factoryToolRevisions)
      .where(
        and(
          scopeWhere(input),
          eq(factoryToolRevisions.id, input.revisionId),
        ),
      )
      .get();
    if (!revision) {
      throw new ToolRevisionError(
        "TOOL_REVISION_NOT_FOUND",
        "没有这个 tenant/domain 下的工具 revision",
        404,
      );
    }
    if (revision.status !== "draft") {
      throw new ToolRevisionError(
        "TOOL_REVISION_NOT_ACTIVATABLE",
        "只有 draft revision 可以拒绝；active 请先激活另一个 revision",
        409,
      );
    }
    const now = new Date();
    const rejected = tx
      .update(factoryToolRevisions)
      .set({
        status: "rejected",
        reviewedBy: actor,
        reviewedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          scopeWhere({
            tenantId: input.tenantId,
            domainId: input.domainId,
            name: revision.name,
          }),
          eq(factoryToolRevisions.id, revision.id),
          eq(factoryToolRevisions.definitionHash, revision.definitionHash),
          eq(factoryToolRevisions.status, "draft"),
        ),
      )
      .run();
    if ((rejected as { changes?: number }).changes !== 1) {
      throw new ToolRevisionError(
        "TOOL_REVISION_CONFLICT",
        "revision 拒绝 CAS 失败；它可能已被另一位审核者处理",
        409,
      );
    }
  });
  return getToolRevision(input)!;
}

/** Deactivate an active managed tool without deleting immutable history. The
 * active projection and ledger transition are one transaction. */
export function deactivateToolRevision(input: {
  tenantId: string;
  domainId?: string | null;
  name: string;
  actor: string;
  expectedActiveRevisionId: string;
}): ManagedToolRevision {
  const actor = input.actor.trim();
  if (!actor) {
    throw new ToolRevisionError(
      "TOOL_REVISION_NOT_ACTIVE",
      "停用工具需要可审计的登录用户身份",
      403,
    );
  }
  if (hasFactoryActiveWork(input.tenantId)) {
    throw new ToolRevisionError(
      "FACTORY_EXECUTION_ACTIVE",
      "Factory 正在使用当前工具快照；本轮结束前不能停用工具",
      409,
    );
  }
  const projectionDomainKey =
    input.domainId === "__unbound__" ? "" : input.domainId ?? "";
  getDb().transaction((tx) => {
    const now = new Date();
    const active = tx
      .select()
      .from(factoryToolRevisions)
      .where(
        and(
          scopeWhere(input),
          eq(factoryToolRevisions.status, "active"),
        ),
      )
      .get();
    if (!active) {
      throw new ToolRevisionError(
        "TOOL_REVISION_NOT_ACTIVE",
        "没有可停用的 managed active revision；legacy projection 不会被静默删除",
        404,
      );
    }
    if (active.id !== input.expectedActiveRevisionId) {
      throw new ToolRevisionError(
        "TOOL_REVISION_CONFLICT",
        `active revision 已变化（expected=${input.expectedActiveRevisionId}, current=${active.id}）；请刷新后重试`,
        409,
      );
    }
    const projection = tx
      .select({ definitionHash: factoryTools.definitionHash })
      .from(factoryTools)
      .where(
        and(
          eq(factoryTools.scopeKey, input.tenantId),
          eq(factoryTools.domainKey, projectionDomainKey),
          eq(factoryTools.name, input.name),
        ),
      )
      .get();
    if (
      !active.activationProbeHash ||
      !projection ||
      projection.definitionHash !== active.activationProbeHash
    ) {
      throw new ToolRevisionError(
        "TOOL_REVISION_CONFLICT",
        "runtime projection 与 active revision 的 probe receipt 已漂移；不会误删，需先修复 ledger/projection 一致性",
        409,
      );
    }
    const retired = tx
      .update(factoryToolRevisions)
      .set({
        status: "retired",
        reviewedBy: actor,
        reviewedAt: now,
        retiredAt: now,
        updatedAt: now,
      })
      .where(
        and(
          scopeWhere(input),
          eq(factoryToolRevisions.id, active.id),
          eq(factoryToolRevisions.definitionHash, active.definitionHash),
          eq(factoryToolRevisions.status, "active"),
        ),
      )
      .run();
    if ((retired as { changes?: number }).changes !== 1) {
      throw new ToolRevisionError(
        "TOOL_REVISION_CONFLICT",
        "active revision retire CAS 失败；本次停用已回滚",
        409,
      );
    }
    const removed = tx
      .delete(factoryTools)
      .where(
        and(
          eq(factoryTools.scopeKey, input.tenantId),
          eq(factoryTools.domainKey, projectionDomainKey),
          eq(factoryTools.name, input.name),
        ),
      )
      .run();
    if ((removed as { changes?: number }).changes !== 1) {
      throw new ToolRevisionError(
        "TOOL_REVISION_CONFLICT",
        "active projection 缺失或重复；ledger retire 已回滚",
        409,
      );
    }
  });
  return getToolRevision({
    tenantId: input.tenantId,
    domainId: input.domainId,
    revisionId: input.expectedActiveRevisionId,
    name: input.name,
  })!;
}
