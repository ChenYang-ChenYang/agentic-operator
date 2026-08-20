// FsAgentDraftStore — persists the agents a finished factory run produced as durable,
// reviewable DRAFTS on disk (the new arch's stand-in for the OLD syncDomainDrafts draft
// AgentVersion rows). Each successful delivery lands under
// <dataRoot>/factory-drafts/<domain>/versions/<version>/ with its specs, generated
// modules and regression.json; `latest` is only an atomic compatibility pointer.
// Versions survive restarts, stay inspectable/replayable, and can later be
// PROMOTED to real Fleet agents without losing prior evidence.
//
// Deliberately kept OFF the live agents/workflows/agentVersions tables: a generated draft
// must never silently become a running production agent. Promotion (draft → manifest +
// DB rows) is an explicit, separate step.

import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type {
  AgentDraft,
  AgentDraftRegressionEvidence,
  AgentDraftSaveReceipt,
  AgentDraftStore,
  GeneratedAgentSpec,
} from "@agentic/agent-factory";
import {
  canonicalEvidenceJson,
  isSecretShapedString,
  lintGeneratedToolCode,
  renderTsFunctionModule,
  specsFingerprint,
  validateAgentCode,
  validateIntegrationToolConfig,
  validatePlan,
} from "@agentic/agent-factory";
import { validateDecisionTables } from "@agentic/shared";
import {
  buildRegressionArtifact,
  replayRegressionArtifact,
  type RegressionReplayOptions,
  type RegressionReplayResult,
} from "./regression-artifact";
import { FsFactoryFixtureAssetStore } from "./fixture-asset-store";
import { materializeFactoryFixturePayload } from "./fixture-materializer";

function dataRoot(): string {
  const r = process.env.AGENTIC_DATA_ROOT?.trim() || "./data";
  return path.isAbsolute(r) ? r : path.resolve(process.cwd(), r);
}
const safe = (s: string) => (s || "_").replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 80);
const exactSeg = (s: string) => `${safe(s)}-${createHash("sha256").update(s, "utf8").digest("hex").slice(0, 16)}`;
const legacyDraftsDir = (domain: string) => path.join(dataRoot(), "factory-drafts", safe(domain));
const VERSION_ID = /^v-[A-Za-z0-9-]{3,120}$/;

export interface DraftStoreScope {
  tenantId: string;
  tenantSlug: string;
  ontologyDomainId?: string;
}

type ScopedAgentDraft = AgentDraft & {
  /** Immutable provenance written for tenant-scoped drafts. */
  ownerTenantId?: string;
  bindingDomainId?: string;
};

export interface DraftVersionSummary {
  versionId: string;
  createdAt: string;
  slugs: string[];
  /** The immutable suite can be replayed successfully. This intentionally
   * says nothing about production connectivity. */
  replayReady: boolean;
  /** Backward-compatible alias for replayReady; never use it as promotion
   * authorization. */
  regressionReady: boolean;
  regressionStatus: "missing" | "legacy_ready" | "pending_replay" | "ready" | "invalid";
  /** Server-derived from the replay receipt. Browser booleans are never
   * consulted by preview/review/promotion. */
  promotionGateAdmission: boolean;
  promotionEligible: boolean;
  promotionEvidenceReady: boolean;
  promotionBlockers: string[];
  evidenceQualification: RegressionEvidenceQualificationView;
}

export interface RegressionEvidenceQualificationView {
  schema: "agent-factory-regression-evidence-qualification/v1";
  replay: "sandbox_verified" | "blocked";
  promotion: "candidate" | "blocked";
  blockers: Array<{
    code: "live_probe_required" | "write_probe_incomplete" | "tool_evidence_invalid" | "replay_not_ready";
    detail: string;
  }>;
}

/** Raised when a browser or sandbox tries to fork an immutable draft that is
 * no longer the tenant's current projection.  Callers must refresh instead of
 * silently moving `latest` backwards and losing somebody else's edit. */
export class DraftVersionConflictError extends Error {
  readonly code = "draft_version_conflict" as const;

  constructor(
    readonly expectedVersionId: string,
    readonly currentVersionId: string | null,
  ) {
    super(`draft version conflict: expected ${expectedVersionId}, current ${currentVersionId ?? "none"}`);
    this.name = "DraftVersionConflictError";
  }
}

const REGRESSION_VALIDATION_REQUIRED_FILE = "regression-validation-required.json";
const REGRESSION_VALIDATION_STATUS_SCHEMA = "agent-factory-regression-validation-status/v1" as const;

interface RegressionValidationStatus {
  schema: typeof REGRESSION_VALIDATION_STATUS_SCHEMA;
  status: "ready" | "invalid";
  checkedAt: string;
  resultCount: number;
  errorCount: number;
  suiteFingerprint?: string;
  /** Re-derived by replayRegressionArtifact; never supplied by Web/API. */
  promotionEvidenceReady?: boolean;
  evidenceQualification?: RegressionEvidenceQualificationView;
}

interface RegressionValidationState {
  required: boolean;
  status: "legacy_ready" | "pending_replay" | "ready" | "invalid";
  receipt?: RegressionValidationStatus;
}

const qualificationBlocker = (
  error: string,
): RegressionEvidenceQualificationView["blockers"][number] => {
  const code = /write[- ]?probe|idempotency|cleanup|absence/i.test(error)
      ? "write_probe_incomplete" as const
      : /live[- ]?probe|not a live-probe/i.test(error)
        ? "live_probe_required" as const
        : "tool_evidence_invalid" as const;
  const detail = code === "write_probe_incomplete"
      ? "写入型工具尚未证明创建、幂等、清理和删除后缺席。"
      : "沙箱回放证据与当前定义、配置或不可变工件不一致，不能进入 production commit gate。";
  return { code, detail };
};

function replayQualification(
  replay: Pick<RegressionReplayResult, "pass" | "promotionEvidenceReady" | "promotionEvidenceErrors">,
): RegressionEvidenceQualificationView {
  if (!replay.pass) {
    return {
      schema: "agent-factory-regression-evidence-qualification/v1",
      replay: "blocked",
      promotion: "blocked",
      blockers: [{ code: "replay_not_ready", detail: "不可变回归套件尚未完整重放通过。" }],
    };
  }
  const promotionErrors = replay.promotionEvidenceErrors?.length
    ? replay.promotionEvidenceErrors
    : replay.promotionEvidenceReady === true
      ? []
      : ["live probe required"];
  const blockers = [...new Map(
    promotionErrors
      .map(qualificationBlocker)
      .map((entry) => [entry.code, entry] as const),
  ).values()];
  const eligible = replay.promotionEvidenceReady === true && blockers.length === 0;
  return {
    schema: "agent-factory-regression-evidence-qualification/v1",
    replay: "sandbox_verified",
    promotion: eligible ? "candidate" : "blocked",
    blockers: eligible ? [] : blockers,
  };
}

const legacyReplayQualification = (): RegressionEvidenceQualificationView => ({
  schema: "agent-factory-regression-evidence-qualification/v1",
  replay: "sandbox_verified",
  promotion: "blocked",
  blockers: [{
    code: "tool_evidence_invalid",
    detail: "旧版本没有独立的生产证据资格回执；可查看或回放，但必须重新跑新沙箱后才能上线。",
  }],
});

const blockedReplayQualification = (): RegressionEvidenceQualificationView => ({
  schema: "agent-factory-regression-evidence-qualification/v1",
  replay: "blocked",
  promotion: "blocked",
  blockers: [{ code: "replay_not_ready", detail: "不可变回归套件尚未完整重放通过。" }],
});

function validRegressionQualification(value: unknown): value is RegressionEvidenceQualificationView {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Partial<RegressionEvidenceQualificationView>;
  return row.schema === "agent-factory-regression-evidence-qualification/v1"
    && (row.replay === "sandbox_verified" || row.replay === "blocked")
    && (row.promotion === "candidate" || row.promotion === "blocked")
    && Array.isArray(row.blockers)
    && row.blockers.every((blocker) => Boolean(
      blocker
      && typeof blocker.detail === "string"
      && ["live_probe_required", "write_probe_incomplete", "tool_evidence_invalid", "replay_not_ready"].includes(blocker.code),
    ));
}

/** A deliberately top-level patch. Nested merge semantics are ambiguous for
 * plans/contracts, so callers replace a complete field or explicitly unset an
 * optional field. Immutable identity fields are not in this allow-list. */
export interface StructuredDraftPatch {
  set?: Record<string, unknown>;
  unset?: string[];
}

export type DraftEditorValueType =
  | "string"
  | "multiline"
  | "code"
  | "integer"
  | "number"
  | "boolean"
  | "enum"
  | "string_array"
  | "json";

export interface DraftEditorFieldContract {
  key: string;
  label: string;
  help: string;
  valueType: DraftEditorValueType;
  /** Ontology-derived fields remain visible for review, but only implementation
   * fields may be changed in a draft. The API enforces the same flag. */
  editable: boolean;
  readonlyReason?: string;
  unsettable: boolean;
  enumValues?: string[];
  present: boolean;
  /** Sensitive historic values are never returned to the browser. The field
   * can still be replaced explicitly, but the editor must start empty. */
  valueStatus: "available" | "withheld_sensitive";
  value?: unknown;
}

export interface DraftEditorContract {
  schema: "agent-factory-draft-editor/v1";
  scope: {
    tenantId: string;
    tenantSlug: string;
    domain: string;
    slug: string;
    versionId: string;
  };
  fields: DraftEditorFieldContract[];
  evidenceEffect: typeof DRAFT_EDIT_EVIDENCE_EFFECT;
}

export interface PatchedDraftVersion {
  domain: string;
  versionId: string;
  baseVersionId: string;
  changedSlug: string;
  drafts: AgentDraft[];
  /** Editing a reviewed artifact always requires a fresh sandbox run. */
  regressionReady: false;
  evidenceEffect: typeof DRAFT_EDIT_EVIDENCE_EFFECT;
}

export interface SandboxedDraftVersion {
  domain: string;
  versionId: string;
  baseVersionId: string;
  drafts: AgentDraft[];
  /** Fresh evidence exists, but promotion remains blocked until its exact
   * immutable artifact has replayed and a durable ready receipt is written. */
  regressionReady: false;
  regressionStatus: "pending_replay";
}

const UNSETTABLE_SPEC_FIELDS = new Set<keyof GeneratedAgentSpec>([
  "toolConfigs", "toolProfileRefs", "integrationRequirements", "integrationBindings", "stateBindings",
  "designReasoning", "toolRationale", "decisionLogic", "plan", "decisionTables", "hitlGate", "toolFlow",
  "generatedCode", "inputSchema", "outputSchema", "codeSource", "codeExecuted",
  "probeReason", "compensationEvent", "isSubAgent", "parentAction", "parentTask",
]);

interface DraftEditorFieldDefinition {
  key: keyof GeneratedAgentSpec;
  label: string;
  help: string;
  valueType: DraftEditorValueType;
  enumValues?: readonly string[];
  editable?: boolean;
  readonlyReason?: string;
}

const ONTOLOGY_DERIVED_READONLY_REASON =
  "这个字段来自 Allmeta Ontology，是生成代码的业务契约。请先更新 Allmeta Ontology 后重新生成。";
const IDENTITY_READONLY_REASON =
  "Agent 身份和 Action 归属不能在草稿中修改。请先更新 Allmeta Ontology 后重新生成。";
const IMMUTABLE_IDENTITY_FIELDS = new Set<string>([
  "key", "actionName", "slug", "short", "domainId",
]);

/** The single runtime contract for fields shown in the draft editor. The Web
 * reads both editability and read-only guidance over HTTP; it does not carry
 * an Action- or domain-specific field list. Identity, execution authority and
 * sandbox-only configuration remain intentionally absent. */
export const DRAFT_EDITOR_FIELD_DEFINITIONS = [
  { key: "nameZh", label: "显示名称", help: "给人工看的 Agent 名称。", valueType: "string" },
  { key: "kind", label: "执行类型", help: "LLM Agent 或显式模拟人工步骤。", valueType: "enum", enumValues: ["llm", "simulated-human"] },
  { key: "trigger", label: "消费事件", help: "由 Ontology Action 的触发事件生成。", valueType: "string_array", editable: false, readonlyReason: ONTOLOGY_DERIVED_READONLY_REASON },
  { key: "emit", label: "发出事件", help: "由 Ontology Action 的结果事件生成。", valueType: "string_array", editable: false, readonlyReason: ONTOLOGY_DERIVED_READONLY_REASON },
  // Tool selection is an atomic contract: tools, policies, side effects,
  // bindings and execution evidence must be rebuilt together by the Factory.
  // A field-only PATCH cannot safely perform that operation, so `tools` is
  // intentionally absent from the browser editor.
  { key: "toolConfigs", label: "工具非密钥配置", help: "只允许非密钥配置；凭证必须写成 *_env 环境变量引用。", valueType: "json" },
  { key: "toolProfileRefs", label: "工具配置档引用", help: "工具名到已确认 profile id 的映射。", valueType: "json" },
  { key: "unresolvedTools", label: "未解析工具", help: "仍需人工补齐的工具名数组。", valueType: "string_array" },
  { key: "integrationRequirements", label: "集成需求", help: "由 Ontology Action 的外部系统需求生成。", valueType: "json", editable: false, readonlyReason: ONTOLOGY_DERIVED_READONLY_REASON },
  { key: "integrationBindings", label: "集成绑定", help: "由 Ontology 集成需求和已验证工具能力生成。", valueType: "json", editable: false, readonlyReason: ONTOLOGY_DERIVED_READONLY_REASON },
  { key: "objects", label: "数据对象", help: "由 Ontology Action 关联的 DataObject 生成。", valueType: "string_array", editable: false, readonlyReason: ONTOLOGY_DERIVED_READONLY_REASON },
  { key: "stateBindings", label: "状态读写绑定", help: "由 Ontology DataObject 的读写契约生成。", valueType: "json", editable: false, readonlyReason: ONTOLOGY_DERIVED_READONLY_REASON },
  { key: "systemPrompt", label: "系统提示词", help: "Agent 的决策职责和边界。", valueType: "multiline" },
  { key: "userPrompt", label: "用户提示词", help: "运行时追加给模型的任务上下文模板。", valueType: "multiline" },
  { key: "designReasoning", label: "设计说明", help: "解释当前设计为何符合业务契约。", valueType: "multiline" },
  { key: "toolRationale", label: "工具选择说明", help: "解释每个工具的用途和边界。", valueType: "multiline" },
  { key: "decisionLogic", label: "决策逻辑说明", help: "人可读的分支说明；可执行分支应同时体现在决策表。", valueType: "multiline" },
  { key: "steps", label: "执行步骤", help: "完整替换生成步骤数组。", valueType: "json" },
  { key: "plan", label: "结构化计划", help: "完整替换运行时结构化计划。", valueType: "json" },
  { key: "decisionTables", label: "决策表", help: "完整替换机器可执行的业务路由表。", valueType: "json" },
  { key: "ruleRefs", label: "规则引用", help: "由 Ontology Action 关联的 canonical Rule 生成。", valueType: "string_array", editable: false, readonlyReason: ONTOLOGY_DERIVED_READONLY_REASON },
  { key: "retries", label: "重试次数", help: "0 到 10 的整数。", valueType: "integer" },
  { key: "hitl", label: "需要人工介入", help: "是否在执行中等待人工决策。", valueType: "boolean" },
  { key: "confidence", label: "设计置信度", help: "0 到 1 之间的数值。", valueType: "number" },
  { key: "promptSource", label: "提示词来源", help: "记录提示词的生成来源。", valueType: "enum", enumValues: ["llm", "ontology", "ontology-desc", "fallback"] },
  { key: "hitlGate", label: "人工门配置", help: "人工等待、恢复和超时契约。", valueType: "json" },
  { key: "toolFlow", label: "工具执行流", help: "并行执行或逐步 ReAct。", valueType: "enum", enumValues: ["parallel", "sequential-react"] },
  { key: "generatedCode", label: "生成代码", help: "完整替换生成的 TypeScript；服务端会重新 lint 和编译。", valueType: "code" },
  { key: "inputSchema", label: "输入契约", help: "由 Ontology 输入事件的 event_data 生成。", valueType: "json", editable: false, readonlyReason: ONTOLOGY_DERIVED_READONLY_REASON },
  { key: "outputSchema", label: "输出契约", help: "由 Ontology 输出事件的 event_data 生成。", valueType: "json", editable: false, readonlyReason: ONTOLOGY_DERIVED_READONLY_REASON },
  { key: "codeSource", label: "代码来源", help: "AI 生成或确定性 renderer。", valueType: "enum", enumValues: ["ai", "render"] },
  { key: "codeExecuted", label: "执行生成代码", help: "是否启用经审阅的 CodeAct 运行路径。", valueType: "boolean" },
  { key: "probeReason", label: "探针说明", help: "代码装载探针未通过时的原因。", valueType: "multiline" },
  { key: "compensationEvent", label: "补偿事件", help: "硬失败时发出的 Saga 补偿事件名。", valueType: "string" },
  { key: "isSubAgent", label: "子 Agent", help: "是否由父 Agent 编排。", valueType: "boolean" },
  { key: "parentAction", label: "父 Action", help: "父级 Ontology Action 名称。", valueType: "string" },
  { key: "parentTask", label: "父任务", help: "父级编排任务标识。", valueType: "string" },
] as const satisfies readonly DraftEditorFieldDefinition[];

const EDITABLE_SPEC_FIELDS = new Set<keyof GeneratedAgentSpec>(
  DRAFT_EDITOR_FIELD_DEFINITIONS
    .filter((field) => !("editable" in field) || field.editable !== false)
    .map((field) => field.key),
);

const DRAFT_EDITOR_FIELD_BY_KEY = new Map<keyof GeneratedAgentSpec, DraftEditorFieldDefinition>(
  DRAFT_EDITOR_FIELD_DEFINITIONS.map((field) => [field.key, field]),
);

function draftFieldReadonlyReason(field: string): string | null {
  const definition = DRAFT_EDITOR_FIELD_BY_KEY.get(field as keyof GeneratedAgentSpec);
  if (definition?.editable === false) {
    return definition.readonlyReason ?? ONTOLOGY_DERIVED_READONLY_REASON;
  }
  return IMMUTABLE_IDENTITY_FIELDS.has(field) ? IDENTITY_READONLY_REASON : null;
}

export const DRAFT_EDIT_EVIDENCE_EFFECT = {
  carriedForward: false,
  invalidatedForNewVersion: ["human_review", "sandbox", "regression", "promotion_preview"],
  requiredNext: ["human_review", "sandbox_replay", "promotion_preview"],
} as const;

const ENV_REFERENCE = /^[A-Z][A-Z0-9_]{1,127}$/;
const FIXTURE_ASSET_REFERENCE = /\bffa-[0-9a-f]{32}\b/i;
const DATA_URL_BYTES = /data:[^;,\s]+;base64,[a-z0-9+/=_-]+/i;
const PRIVATE_KEY = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i;
const JWT_LIKE = /\beyJ[a-z0-9_-]{8,}\.[a-z0-9_-]{8,}\.[a-z0-9_-]{8,}\b/i;
const PROVIDER_KEY_LIKE = /\b(?:sk|rk|pk)_[a-z0-9_-]{16,}\b|\bsk-[a-z0-9_-]{16,}\b/i;
const LONG_BASE64 = /^(?:[A-Za-z0-9+/]{4}){64,}(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const PADDED_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)$/;

function canonicalEditorKey(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
}

function isEnvReferenceField(key: string, value: unknown): boolean {
  const canonical = canonicalEditorKey(key);
  return canonical.length > 4
    && canonical.endsWith("_env")
    && typeof value === "string"
    && ENV_REFERENCE.test(value);
}

const SENSITIVE_EDITOR_KEYS = new Set([
  "asset_id", "assetid", "base64",
  "auth", "auth_header", "authorization", "authorization_header",
  "bearer", "bearer_token", "cookie", "session", "session_id",
  "password", "passwd", "secret", "secret_key", "private_key",
  "token", "access_token", "refresh_token",
  "credential", "credentials", "client_secret",
  "api_key", "access_key", "client_key", "key",
]);

function sensitiveEditorKey(key: string, value: unknown): boolean {
  if (/^~(?:[01])?key$/i.test(key)) return false;
  const canonical = canonicalEditorKey(key);
  if (SENSITIVE_EDITOR_KEYS.has(canonical)) return true;
  if (typeof value !== "string") return false;
  // Common HTTP/header/config variants such as X-Auth-Token,
  // proxyAuthorization and signing_private_key must not bypass the exact-key
  // list. A correctly named *_env field is admitted before this check.
  return /^(?:x_|proxy_|http_)?(?:auth|authorization|api_key)(?:_header|_token)?$/.test(canonical)
    || /_(?:auth|authorization|api_key|access_key|private_key|secret_key|client_secret|password|passwd|token|credential|cookie)$/.test(canonical);
}

function fixtureBytesInValue(key: string, value: unknown): boolean {
  const normalized = canonicalEditorKey(key).replace(/_/g, "");
  if (!["bytes", "content", "body", "payload", "raw", "filecontent", "filebytes"].includes(normalized)) return false;
  if (typeof value === "string") return PADDED_BASE64.test(value) || LONG_BASE64.test(value);
  return ["bytes", "filebytes", "raw"].includes(normalized)
    && Array.isArray(value)
    && value.length > 0
    && value.every((entry) => typeof entry === "number" && Number.isInteger(entry) && entry >= 0 && entry <= 255);
}

/** Return only a category, never the offending value, so validation and audit
 * messages cannot echo a credential or fixture payload. */
export function draftEditorSensitiveCategory(value: unknown): string | null {
  const visit = (entry: unknown): string | null => {
    if (typeof entry === "string") {
      if (FIXTURE_ASSET_REFERENCE.test(entry)) return "fixture_asset_reference";
      if (DATA_URL_BYTES.test(entry) || LONG_BASE64.test(entry)) return "fixture_bytes";
      if (isSecretShapedString(entry) || PRIVATE_KEY.test(entry) || JWT_LIKE.test(entry) || PROVIDER_KEY_LIKE.test(entry)) return "literal_credential";
      return null;
    }
    if (Array.isArray(entry)) {
      for (const item of entry) {
        const category = visit(item);
        if (category) return category;
      }
      return null;
    }
    if (!entry || typeof entry !== "object") return null;
    for (const [key, nested] of Object.entries(entry as Record<string, unknown>)) {
      if (fixtureBytesInValue(key, nested)) return "fixture_bytes";
      if (!isEnvReferenceField(key, nested) && sensitiveEditorKey(key, nested)) {
        return canonicalEditorKey(key).replace(/_/g, "") === "assetid"
          ? "fixture_asset_reference"
          : canonicalEditorKey(key) === "base64"
            ? "fixture_bytes"
            : "literal_credential";
      }
      const category = visit(nested);
      if (category) return category;
    }
    return null;
  };
  return visit(value);
}

const isMissing = (error: unknown): boolean => (error as NodeJS.ErrnoException)?.code === "ENOENT";

async function syncDirectory(dir: string): Promise<void> {
  const handle = await fs.open(dir, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncTree(root: string): Promise<void> {
  const entries = await fs.readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) {
      await syncTree(file);
    } else if (entry.isFile()) {
      const handle = await fs.open(file, "r");
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    }
  }
  await syncDirectory(root);
}

async function writeDurableAtomic(file: string, contents: string, exclusive = false): Promise<void> {
  if (exclusive) {
    try {
      await fs.access(file);
      const error = new Error(`durable file already exists: ${file}`) as NodeJS.ErrnoException;
      error.code = "EEXIST";
      throw error;
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(temporary, "wx", 0o600);
    await handle.writeFile(contents, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.rename(temporary, file);
    await syncDirectory(path.dirname(file));
  } catch (error) {
    if (handle) await handle.close().catch(() => undefined);
    await fs.unlink(temporary).catch((cleanupError) => {
      if (!isMissing(cleanupError)) throw cleanupError;
    });
    throw error;
  }
}

export class FsAgentDraftStore implements AgentDraftStore {
  constructor(
    private readonly scope?: DraftStoreScope,
    private readonly fixtureAssetStore?: FsFactoryFixtureAssetStore,
  ) {}

  private acceptsDomain(domain: string): boolean {
    return !this.scope?.ontologyDomainId || this.scope.ontologyDomainId === domain;
  }

  private validScopedDraft(draft: ScopedAgentDraft, domain: string): boolean {
    if (!this.scope) return true;
    return draft.domain === domain && draft.spec?.domainId === domain &&
      (!draft.ownerTenantId || draft.ownerTenantId === this.scope.tenantId) &&
      (!draft.bindingDomainId || draft.bindingDomainId === (this.scope.ontologyDomainId ?? domain));
  }

  private dir(domain: string): string {
    return this.scope
      ? path.join(dataRoot(), "factory-drafts", "_tenants", safe(this.scope.tenantId), exactSeg(domain))
      : legacyDraftsDir(domain);
  }

  private regressionValidationRequiredPath(domain: string, versionId: string): string {
    return path.join(this.dir(domain), "versions", versionId, REGRESSION_VALIDATION_REQUIRED_FILE);
  }

  private regressionValidationStatusPath(domain: string, versionId: string): string {
    return path.join(this.dir(domain), "regression-validation", `${versionId}.json`);
  }

  private async regressionValidationState(domain: string, versionId: string): Promise<RegressionValidationState> {
    if (!VERSION_ID.test(versionId)) return { required: true, status: "invalid" };
    try {
      await fs.access(this.regressionValidationRequiredPath(domain, versionId));
    } catch (error) {
      if (isMissing(error)) return { required: false, status: "legacy_ready" };
      throw error;
    }
    try {
      const parsed = JSON.parse(await fs.readFile(this.regressionValidationStatusPath(domain, versionId), "utf8")) as Partial<RegressionValidationStatus>;
      if (
        parsed.schema !== REGRESSION_VALIDATION_STATUS_SCHEMA
        || (parsed.status !== "ready" && parsed.status !== "invalid")
        || typeof parsed.checkedAt !== "string"
        || Number.isNaN(Date.parse(parsed.checkedAt))
        || !Number.isInteger(parsed.resultCount)
        || !Number.isInteger(parsed.errorCount)
        || Number(parsed.resultCount) < 0
        || Number(parsed.errorCount) < 0
        || (parsed.promotionEvidenceReady !== undefined && typeof parsed.promotionEvidenceReady !== "boolean")
        || (parsed.evidenceQualification !== undefined && !validRegressionQualification(parsed.evidenceQualification))
        || (parsed.promotionEvidenceReady === true && (
          !validRegressionQualification(parsed.evidenceQualification)
          || parsed.evidenceQualification.promotion !== "candidate"
          || parsed.evidenceQualification.blockers.length !== 0
        ))
        || (parsed.status === "ready" && (
          typeof parsed.suiteFingerprint !== "string"
          || !parsed.suiteFingerprint
          || Number(parsed.resultCount) < 1
          || Number(parsed.errorCount) !== 0
        ))
      ) {
        // A malformed sidecar is never interpreted as success. Keep the
        // immutable version visible, but promotion remains blocked.
        return { required: true, status: "invalid" };
      }
      return {
        required: true,
        status: parsed.status,
        receipt: parsed as RegressionValidationStatus,
      };
    } catch (error) {
      if (isMissing(error)) return { required: true, status: "pending_replay" };
      if (error instanceof SyntaxError) return { required: true, status: "invalid" };
      throw error;
    }
  }

  private async writeRegressionValidationStatus(
    domain: string,
    versionId: string,
    replay: Pick<RegressionReplayResult, "pass" | "results" | "errors" | "suiteFingerprint" | "promotionEvidenceReady" | "promotionEvidenceErrors">,
  ): Promise<void> {
    const state = await this.regressionValidationState(domain, versionId);
    if (!state.required) throw new Error(`regression validation marker missing: ${versionId}`);
    if (state.status !== "pending_replay") throw new Error(`regression validation already finalized: ${versionId}/${state.status}`);
    const evidenceQualification = replayQualification(replay);
    const status: RegressionValidationStatus = {
      schema: REGRESSION_VALIDATION_STATUS_SCHEMA,
      status: replay.pass
        && Boolean(replay.suiteFingerprint)
        && replay.results.length > 0
        && replay.errors.length === 0
        ? "ready"
        : "invalid",
      checkedAt: new Date().toISOString(),
      resultCount: replay.results.length,
      errorCount: replay.errors.length,
      ...(replay.suiteFingerprint ? { suiteFingerprint: replay.suiteFingerprint } : {}),
      promotionEvidenceReady: replay.promotionEvidenceReady === true
        && evidenceQualification.promotion === "candidate",
      evidenceQualification,
    };
    const dir = path.dirname(this.regressionValidationStatusPath(domain, versionId));
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    await writeDurableAtomic(
      this.regressionValidationStatusPath(domain, versionId),
      `${JSON.stringify(status, null, 2)}\n`,
      true,
    );
  }

  /** Tenant-scoped layout used by the first binding migration. It is safe to
   * read only when the sanitizer was injective for this id. */
  private oldScopedDir(domain: string): string | null {
    if (!this.scope || safe(domain) !== domain) return null;
    return path.join(dataRoot(), "factory-drafts", "_tenants", safe(this.scope.tenantId), safe(domain));
  }

  /** Legacy drafts are claimable only by the tenant whose immutable slug equals
   *  the old directory name. Never dual-read a legacy domain into another tenant. */
  private legacyDir(domain: string): string | null {
    if (!this.scope) return legacyDraftsDir(domain);
    return this.scope.tenantSlug === domain
      ? legacyDraftsDir(domain)
      : null;
  }

  private async replaceSymlink(link: string, target: string): Promise<void> {
    const temporary = `${link}.${process.pid}.${randomUUID()}.tmp`;
    await fs.symlink(target, temporary);
    try {
      await fs.rename(temporary, link);
      await syncDirectory(path.dirname(link));
    } catch (error) {
      await fs.unlink(temporary).catch(() => undefined);
      throw error;
    }
  }

  private async currentVersionId(domain: string): Promise<string | null> {
    const latest = path.join(this.dir(domain), "latest");
    try {
      const target = await fs.readlink(latest);
      const versionId = path.basename(target);
      return VERSION_ID.test(versionId) ? versionId : null;
    } catch (error) {
      if (isMissing(error)) return null;
      // A few older stores used a real directory instead of a symlink. Resolve
      // it without consulting any draft content, while keeping malformed
      // projections fail-closed.
      if ((error as NodeJS.ErrnoException)?.code !== "EINVAL") throw error;
      try {
        const resolved = await fs.realpath(latest);
        const versionId = path.basename(resolved);
        return VERSION_ID.test(versionId) ? versionId : null;
      } catch (resolvedError) {
        if (isMissing(resolvedError)) return null;
        throw resolvedError;
      }
    }
  }

  private async requireCurrentVersion(domain: string, expectedVersionId: string): Promise<void> {
    const current = await this.currentVersionId(domain);
    if (current !== expectedVersionId) {
      throw new DraftVersionConflictError(expectedVersionId, current);
    }
  }

  private async publishVersionProjection(
    domain: string,
    versionId: string,
    specs: GeneratedAgentSpec[],
    expectedLatestVersionId?: string,
  ): Promise<void> {
    if (expectedLatestVersionId) {
      await this.requireCurrentVersion(domain, expectedLatestVersionId);
    }
    const dir = this.dir(domain);
    await this.replaceSymlink(path.join(dir, "latest"), path.join("versions", versionId));
    for (let index = 0; index < specs.length; index++) {
      const spec = specs[index]!;
      const slug = safe(spec.slug || spec.short || spec.actionName || `agent-${index}`);
      await this.replaceSymlink(path.join(dir, `${slug}.json`), path.join("latest", "agents", `${slug}.json`));
      await this.replaceSymlink(path.join(dir, `${slug}.ts`), path.join("latest", "agents", `${slug}.ts`));
      let tombstoneRemoved = false;
      await fs.unlink(path.join(dir, ".deleted", slug)).then(() => { tombstoneRemoved = true; }).catch((error) => {
        if (!isMissing(error)) throw error;
      });
      if (tombstoneRemoved) await syncDirectory(path.join(dir, ".deleted"));
    }
  }

  private async tombstoned(domain: string, slug: string): Promise<boolean> {
    try {
      await fs.access(path.join(this.dir(domain), ".deleted", safe(slug)));
      return true;
    } catch (error) {
      if (isMissing(error)) return false;
      throw error;
    }
  }

  async save(domain: string, specs: GeneratedAgentSpec[], regression?: AgentDraftRegressionEvidence): Promise<number> {
    return (await this.saveWithReceipt(domain, specs, regression)).persisted;
  }

  async saveWithReceipt(
    domain: string,
    specs: GeneratedAgentSpec[],
    regression?: AgentDraftRegressionEvidence,
  ): Promise<AgentDraftSaveReceipt> {
    const persisted = await this.persistVersion(domain, specs, regression);
    return {
      schema: "agent-factory-draft-save/v1",
      persisted: persisted.count,
      versionId: persisted.versionId,
      specsFingerprint: specsFingerprint(specs),
    };
  }

  private async persistVersion(
    domain: string,
    specs: GeneratedAgentSpec[],
    regression?: AgentDraftRegressionEvidence,
    options: {
      requireRegressionValidation?: boolean;
      /** Keep the immutable bundle addressable but do not expose it as the
       * current draft until its replay receipt is ready. */
      publishLatest?: boolean;
      expectedLatestVersionId?: string;
    } = {},
  ): Promise<{ count: number; versionId: string }> {
    if (!this.acceptsDomain(domain) || specs.some((spec) => spec.domainId !== domain)) {
      return { count: 0, versionId: "" };
    }
    if (options.expectedLatestVersionId) {
      await this.requireCurrentVersion(domain, options.expectedLatestVersionId);
    }
    const dir = this.dir(domain);
    const versionsDir = path.join(dir, "versions");
    await fs.mkdir(versionsDir, { recursive: true });
    await syncDirectory(dir);
    const now = new Date().toISOString();
    const versionId = `v-${now.replace(/[-:.TZ]/g, "").slice(0, 17)}-${randomUUID().slice(0, 8)}`;
    const staging = path.join(versionsDir, `.${versionId}.${process.pid}.tmp`);
    const finalDir = path.join(versionsDir, versionId);
    const agentsDir = path.join(staging, "agents");
    await fs.mkdir(agentsDir, { recursive: true });
    const modules = specs.map((spec) => ({ slug: spec.slug, code: renderTsFunctionModule(spec) }));
    let artifact: ReturnType<typeof buildRegressionArtifact> | null = null;
    try {
      const seenCassetteBindings = new Set<string>();
      const portableRegression = regression
        ? {
            ...regression,
            cassetteRefs: await Promise.all((regression.cassetteRefs ?? []).map(async (ref) => {
              // A tool may legitimately be selected with different reviewed
              // configs by different generated functions. De-duplicate the
              // exact binding, never the display name.
              const bindingKey = ref.bindingId || canonicalEvidenceJson({
                tool: ref.tool,
                definitionHash: ref.definitionHash ?? null,
                configHash: ref.configHash ?? null,
                specSlugs: [...(ref.specSlugs ?? [])].sort(),
              });
              if (seenCassetteBindings.has(bindingKey)) {
                throw new Error(`duplicate cassette binding: ${ref.tool}/${bindingKey}`);
              }
              seenCassetteBindings.add(bindingKey);
              const raw = await fs.readFile(path.resolve(ref.path), "utf8");
              let canonical: string;
              try {
                canonical = canonicalEvidenceJson(JSON.parse(raw));
              } catch {
                throw new Error(`cassette is not canonical JSON evidence: ${ref.tool}`);
              }
              const bytes = Buffer.from(canonical, "utf8");
              const contentHash = createHash("sha256").update(bytes).digest("hex");
              if (ref.contentHash && ref.contentHash !== contentHash) {
                throw new Error(`cassette content drift before immutable snapshot: ${ref.tool}`);
              }
              const relativePath = path.posix.join("cassettes", `${safe(ref.tool)}-${contentHash}.json`);
              const destination = path.join(staging, ...relativePath.split("/"));
              await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
              await fs.writeFile(destination, bytes, { mode: 0o600, flag: "wx" });
              return { ...ref, path: relativePath, contentHash };
            })),
          }
        : undefined;
      artifact = portableRegression
        ? buildRegressionArtifact({
            versionId,
            domain,
            createdAt: now,
            specs,
            modules,
            evidence: portableRegression,
            fileNameForSlug: safe,
          })
        : null;
      for (let index = 0; index < specs.length; index++) {
        const spec = specs[index]!;
        const slug = safe(spec.slug || spec.short || spec.actionName || `agent-${index}`);
        const draft: ScopedAgentDraft = {
          domain,
          slug,
          spec,
          createdAt: now,
          versionId,
          ...(artifact ? {
            regression: {
              artifact: `versions/${versionId}/regression.json`,
              evidenceFingerprint: artifact.evidenceFingerprint,
              suiteFingerprint: artifact.suiteFingerprint,
              cleanupReceiptHash: artifact.sandboxCleanupReceipt.absenceProbeHash,
              authoritativeOntology: artifact.authoritativeOntology,
            },
          } : {}),
          ...(this.scope ? { ownerTenantId: this.scope.tenantId, bindingDomainId: this.scope.ontologyDomainId ?? domain } : {}),
        };
        const code = modules.find((entry) => entry.slug === spec.slug)?.code;
        if (code === undefined) throw new Error(`cannot render factory draft ${spec.slug}`);
        const writes = [
          fs.writeFile(path.join(agentsDir, `${slug}.json`), `${JSON.stringify(draft, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" }),
          fs.writeFile(path.join(agentsDir, `${slug}.ts`), code, { encoding: "utf8", mode: 0o600, flag: "wx" }),
        ];
        if (spec.codeExecuted === true) {
          if (!spec.generatedCode?.trim()) throw new Error(`cannot persist CodeAct draft without exact runtime bytes: ${spec.slug}`);
          // Separate immutable execution artifact. Regression replay and
          // production promotion both hash these exact bytes; the rendered
          // `<slug>.ts` module is never used as a look-alike substitute.
          writes.push(fs.writeFile(path.join(agentsDir, `${slug}.codeact.ts`), spec.generatedCode, { encoding: "utf8", mode: 0o600, flag: "wx" }));
        }
        await Promise.all(writes);
      }
      if (artifact) {
        await fs.writeFile(path.join(staging, "regression.json"), `${JSON.stringify(artifact, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
        if (options.requireRegressionValidation) {
          // Immutable declaration inside the bundle. Until a separate durable
          // `ready` receipt exists, list/promotion fail closed. A process crash
          // between persistence and replay therefore cannot create a fake-green
          // version; the evidence bundle itself remains available for audit.
          await fs.writeFile(path.join(staging, REGRESSION_VALIDATION_REQUIRED_FILE), `${JSON.stringify({
            schema: "agent-factory-regression-validation-required/v1",
            versionId,
            createdAt: now,
          }, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
        }
      }
      await syncTree(staging);
      await fs.rename(staging, finalDir);
      await syncDirectory(versionsDir);
    } catch (error) {
      await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }

    // `latest` is the only authoritative mutable pointer; every referenced
    // bundle stays immutable below versions/<versionId>. A sandboxed version
    // remains unpublished until its exact replay has produced a ready receipt.
    if (options.publishLatest !== false) {
      await this.publishVersionProjection(
        domain,
        versionId,
        specs,
        options.expectedLatestVersionId,
      );
    }
    return { count: specs.length, versionId };
  }

  async list(domain: string): Promise<AgentDraft[]> {
    if (!this.acceptsDomain(domain)) return [];
    const dirs = [this.legacyDir(domain), this.oldScopedDir(domain), this.dir(domain)].filter((d, i, a): d is string => !!d && a.indexOf(d) === i);
    const bySlug = new Map<string, AgentDraft>();
    for (const dir of dirs) {
      let files: string[];
      let readDir = path.join(dir, "latest", "agents");
      try {
        files = (await fs.readdir(readDir)).filter((f) => f.endsWith(".json"));
      } catch (error) {
        if (!isMissing(error)) throw error;
        // Backward compatibility: pre-version-store drafts live flat in dir.
        readDir = dir;
        try {
          files = (await fs.readdir(readDir)).filter((f) => f.endsWith(".json"));
        } catch (fallbackError) {
          if (isMissing(fallbackError)) continue;
          throw fallbackError;
        }
      }
      for (const f of files) {
        try {
          const draft = JSON.parse(await fs.readFile(path.join(readDir, f), "utf8")) as ScopedAgentDraft;
          if (this.scope && !this.validScopedDraft(draft, domain)) continue;
          bySlug.set(draft.slug, draft); // scoped dir is last and wins over legacy
        } catch (error) {
          throw new Error(`cannot read factory draft ${path.join(readDir, f)}`, { cause: error });
        }
      }
    }
    const visible: AgentDraft[] = [];
    for (const draft of bySlug.values()) {
      if (!await this.tombstoned(domain, draft.slug)) visible.push(draft);
    }
    return visible.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  /** Read one immutable delivery version by its exact id. The mutable `latest`
   * pointer is deliberately not consulted, so preview/sign-off/promotion can
   * all bind to the same byte-for-byte artifact. */
  async getVersion(domain: string, versionId: string): Promise<AgentDraft[]> {
    if (!this.acceptsDomain(domain) || !VERSION_ID.test(versionId)) return [];
    const readDir = path.join(this.dir(domain), "versions", versionId, "agents");
    let files: string[];
    try {
      files = (await fs.readdir(readDir)).filter((file) => file.endsWith(".json")).sort();
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
    const drafts: AgentDraft[] = [];
    for (const file of files) {
      const draft = JSON.parse(await fs.readFile(path.join(readDir, file), "utf8")) as ScopedAgentDraft;
      if (draft.versionId !== versionId || draft.domain !== domain || draft.spec?.domainId !== domain) {
        throw new Error(`draft version identity mismatch: ${versionId}/${file}`);
      }
      if (this.scope && !this.validScopedDraft(draft, domain)) continue;
      // Tombstones hide only the mutable current projection. Exact immutable
      // versions remain readable for promotion audit and CI regression replay.
      drafts.push(draft);
    }
    return drafts.sort((a, b) => a.slug.localeCompare(b.slug));
  }

  async listVersions(domain: string): Promise<DraftVersionSummary[]> {
    if (!this.acceptsDomain(domain)) return [];
    const currentVersionId = await this.currentVersionId(domain);
    let names: string[];
    try {
      names = (await fs.readdir(path.join(this.dir(domain), "versions")))
        .filter((name) => VERSION_ID.test(name));
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
    const summaries: DraftVersionSummary[] = [];
    for (const versionId of names) {
      const drafts = await this.getVersion(domain, versionId);
      if (!drafts.length) continue;
      const hasRegression = drafts.every((draft) => Boolean(draft.regression));
      const validation = hasRegression
        ? await this.regressionValidationState(domain, versionId)
        : null;
      const validationReady = Boolean(
        validation?.status === "ready"
        && validation.receipt?.suiteFingerprint
        && drafts.every((draft) => draft.regression?.suiteFingerprint === validation.receipt!.suiteFingerprint),
      );
      const replayReady = hasRegression && (!validation?.required || validationReady);
      const qualification = !replayReady
        ? blockedReplayQualification()
        : validation?.required
          ? validRegressionQualification(validation.receipt?.evidenceQualification)
            ? validation.receipt.evidenceQualification
            : legacyReplayQualification()
          : legacyReplayQualification();
      const promotionEvidenceReady = Boolean(
        validationReady
        && validation?.receipt?.promotionEvidenceReady === true
        && qualification.promotion === "candidate"
        && qualification.blockers.length === 0,
      );
      summaries.push({
        versionId,
        createdAt: drafts[0]!.createdAt,
        slugs: drafts.map((draft) => draft.slug),
        replayReady,
        regressionReady: replayReady,
        regressionStatus: !hasRegression
          ? "missing"
          : validation?.required
            ? validation.status === "ready" && !validationReady ? "invalid" : validation.status
            : "legacy_ready",
        promotionGateAdmission: promotionEvidenceReady,
        // Final eligibility needs the current production profile + HMAC live
        // probe gate, which is tenant/runtime state and is derived by the API.
        promotionEligible: false,
        promotionEvidenceReady,
        promotionBlockers: promotionEvidenceReady
          ? ["最终上线资格需要 API 重新读取当前 production profile 与 live-probe/write-proof。"]
          : qualification.blockers.map((blocker) => blocker.detail),
        evidenceQualification: qualification,
      });
    }
    return summaries.sort((a, b) => {
      if (a.versionId === currentVersionId) return -1;
      if (b.versionId === currentVersionId) return 1;
      return b.createdAt.localeCompare(a.createdAt) || b.versionId.localeCompare(a.versionId);
    });
  }

  /** Return the browser editor's complete, tenant-bound field contract for one
   * immutable draft version. Values containing historic credentials, fixture
   * bytes or opaque fixture ids are withheld as a whole, never partially
   * redacted into something that could later be submitted by mistake. */
  async getEditorContract(
    domain: string,
    versionId: string,
    slug: string,
  ): Promise<DraftEditorContract | null> {
    if (!this.scope) throw new Error("草稿编辑必须在明确的租户范围内进行");
    const drafts = await this.getVersion(domain, versionId);
    const target = drafts.find((draft) => draft.slug === safe(slug));
    if (!target) return null;
    const spec = target.spec as unknown as Record<string, unknown>;
    const fields: DraftEditorFieldContract[] = DRAFT_EDITOR_FIELD_DEFINITIONS.map((definition) => {
      const fieldDefinition: DraftEditorFieldDefinition = definition;
      const present = Object.prototype.hasOwnProperty.call(spec, definition.key);
      const value = present ? spec[definition.key] : undefined;
      const sensitive = present && draftEditorSensitiveCategory(value) !== null;
      const editable = fieldDefinition.editable !== false;
      return {
        key: definition.key,
        label: definition.label,
        help: definition.help,
        valueType: definition.valueType,
        editable,
        ...(editable ? {} : { readonlyReason: fieldDefinition.readonlyReason ?? ONTOLOGY_DERIVED_READONLY_REASON }),
        unsettable: editable && UNSETTABLE_SPEC_FIELDS.has(definition.key),
        ...("enumValues" in definition ? { enumValues: [...definition.enumValues] } : {}),
        present,
        valueStatus: sensitive ? "withheld_sensitive" : "available",
        ...(!sensitive && present
          ? { value: JSON.parse(JSON.stringify(value)) as unknown }
          : {}),
      };
    });
    return {
      schema: "agent-factory-draft-editor/v1",
      scope: {
        tenantId: this.scope.tenantId,
        tenantSlug: this.scope.tenantSlug,
        domain,
        slug: target.slug,
        versionId,
      },
      fields,
      evidenceEffect: DRAFT_EDIT_EVIDENCE_EFFECT,
    };
  }

  private validatePatchedSpec(spec: GeneratedAgentSpec): string[] {
    const errors: string[] = [];
    const stringArrays: Array<keyof GeneratedAgentSpec> = ["trigger", "emit", "tools", "unresolvedTools", "objects", "ruleRefs"];
    for (const field of stringArrays) {
      const value = spec[field];
      if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !entry.trim())) {
        errors.push(`${String(field)} must be an array of non-empty strings`);
      }
    }
    if (!(["llm", "simulated-human"] as unknown[]).includes(spec.kind)) errors.push("kind must be llm or simulated-human");
    if (!(["llm", "ontology", "ontology-desc", "fallback"] as unknown[]).includes(spec.promptSource)) errors.push("promptSource is invalid");
    if (spec.toolFlow !== undefined && !(["parallel", "sequential-react"] as unknown[]).includes(spec.toolFlow)) errors.push("toolFlow is invalid");
    if (spec.codeSource !== undefined && !(["ai", "render"] as unknown[]).includes(spec.codeSource)) errors.push("codeSource is invalid");
    if (typeof spec.nameZh !== "string" || !spec.nameZh.trim()) errors.push("nameZh must be non-empty");
    if (typeof spec.systemPrompt !== "string" || !spec.systemPrompt.trim()) errors.push("systemPrompt must be non-empty");
    if (typeof spec.userPrompt !== "string") errors.push("userPrompt must be a string");
    if (!Array.isArray(spec.steps)) errors.push("steps must be an array");
    if (!Number.isInteger(spec.retries) || spec.retries < 0 || spec.retries > 10) errors.push("retries must be an integer from 0 to 10");
    if (typeof spec.confidence !== "number" || spec.confidence < 0 || spec.confidence > 1) errors.push("confidence must be between 0 and 1");
    if (typeof spec.hitl !== "boolean") errors.push("hitl must be a boolean");
    if (spec.plan !== undefined && !Array.isArray(spec.plan)) errors.push("plan must be an array");
    else if (spec.plan) errors.push(...validatePlan(spec.plan, { knownTools: spec.tools, declaredEvents: spec.emit }).errors);
    if (Array.isArray(spec.decisionTables)) errors.push(...validateDecisionTables(spec.decisionTables, { declaredEvents: spec.emit }));
    for (const field of ["inputSchema", "outputSchema", "stateBindings", "integrationRequirements", "integrationBindings", "decisionTables"] as const) {
      if (spec[field] !== undefined && !Array.isArray(spec[field])) errors.push(`${field} must be an array`);
    }
    for (const field of ["generatedCode", "designReasoning", "toolRationale", "decisionLogic", "probeReason", "compensationEvent", "parentAction", "parentTask"] as const) {
      if (spec[field] !== undefined && typeof spec[field] !== "string") errors.push(`${field} must be a string`);
    }
    for (const field of ["codeExecuted", "isSubAgent"] as const) {
      if (spec[field] !== undefined && typeof spec[field] !== "boolean") errors.push(`${field} must be a boolean`);
    }
    if (spec.toolConfigs !== undefined && (!spec.toolConfigs || typeof spec.toolConfigs !== "object" || Array.isArray(spec.toolConfigs))) {
      errors.push("toolConfigs must be an object");
    }
    for (const [toolName, config] of Object.entries(spec.toolConfigs ?? {})) {
      const validation = validateIntegrationToolConfig({ name: toolName }, config, { rejectUnknownKeys: false });
      errors.push(...validation.issues.map((issue) => `toolConfigs.${toolName}.${issue.path}: ${issue.message}`));
    }
    if (spec.toolProfileRefs !== undefined && (!spec.toolProfileRefs || typeof spec.toolProfileRefs !== "object" || Array.isArray(spec.toolProfileRefs))) {
      errors.push("toolProfileRefs must be an object");
    }
    for (const [toolName, profileId] of Object.entries(spec.toolProfileRefs ?? {})) {
      if (typeof profileId !== "string" || !profileId.trim()) {
        errors.push(`toolProfileRefs.${toolName} must be a non-empty profile id`);
      } else if (!spec.toolConfigs?.[toolName]) {
        errors.push(`toolProfileRefs.${toolName} has no expanded toolConfigs entry`);
      }
    }
    return errors;
  }

  /** Apply a human-authored, structured top-level patch by forking the whole
   * immutable version. No regression pointer is copied: even a prompt-only
   * edit changes the executable decision contract and must be sandboxed again. */
  async createPatchedVersion(
    domain: string,
    baseVersionId: string,
    slug: string,
    patch: StructuredDraftPatch,
  ): Promise<PatchedDraftVersion> {
    const base = await this.getVersion(domain, baseVersionId);
    if (!base.length) throw new Error(`draft version not found: ${baseVersionId}`);
    const target = base.find((draft) => draft.slug === safe(slug));
    if (!target) throw new Error(`draft not found in ${baseVersionId}: ${slug}`);
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
      throw new Error("patch 必须是包含 set 或 unset 的对象");
    }
    if (patch.set !== undefined && (!patch.set || typeof patch.set !== "object" || Array.isArray(patch.set))) {
      throw new Error("patch.set 必须是字段到新值的对象");
    }
    if (patch.unset !== undefined && (!Array.isArray(patch.unset) || patch.unset.some((field) => typeof field !== "string" || !field))) {
      throw new Error("patch.unset 必须是非空字段名数组");
    }
    const setEntries = Object.entries(patch?.set ?? {});
    const unset = [...new Set(patch?.unset ?? [])];
    if (!setEntries.length && !unset.length) throw new Error("patch must set or unset at least one editable field");
    const overlap = setEntries.find(([field]) => unset.includes(field));
    if (overlap) throw new Error(`同一个字段不能同时 set 和 unset: ${overlap[0]}`);
    for (const [field] of setEntries) {
      const readonlyReason = draftFieldReadonlyReason(field);
      if (readonlyReason) throw new Error(`${field}：${readonlyReason}`);
      if (!EDITABLE_SPEC_FIELDS.has(field as keyof GeneratedAgentSpec)) throw new Error(`field is immutable or unknown: ${field}`);
    }
    for (const field of unset) {
      const readonlyReason = draftFieldReadonlyReason(field);
      if (readonlyReason) throw new Error(`${field}：${readonlyReason}`);
      if (!UNSETTABLE_SPEC_FIELDS.has(field as keyof GeneratedAgentSpec)) throw new Error(`field cannot be unset: ${field}`);
    }
    for (const [, value] of setEntries) {
      if (draftEditorSensitiveCategory(value)) {
        throw new Error("草稿修改不能包含字面密钥、凭证、fixture bytes 或 fixture asset 引用；请改用已确认的 *_env / profile 引用，并在测试数据界面单独上传 fixture");
      }
    }

    const nextSpec = JSON.parse(JSON.stringify(target.spec)) as GeneratedAgentSpec;
    for (const [field, value] of setEntries) {
      if (value === undefined) throw new Error(`set.${field} cannot be undefined; use unset`);
      (nextSpec as unknown as Record<string, unknown>)[field] = JSON.parse(JSON.stringify(value));
    }
    for (const field of unset) delete (nextSpec as unknown as Record<string, unknown>)[field];
    // Identity can never be smuggled through a structured edit.
    for (const field of ["key", "actionName", "slug", "short", "domainId"] as const) {
      if (nextSpec[field] !== target.spec[field]) throw new Error(`identity field changed: ${field}`);
    }
    if (JSON.stringify(nextSpec) === JSON.stringify(target.spec)) {
      throw new Error("修改内容与当前版本完全相同，不需要创建新版本");
    }
    const validationErrors = this.validatePatchedSpec(nextSpec);
    if (typeof nextSpec.generatedCode === "string" && nextSpec.generatedCode.trim()) {
      const lint = lintGeneratedToolCode(nextSpec.generatedCode);
      if (!lint.ok) validationErrors.push(...lint.violations.map((violation) => `generatedCode: ${violation}`));
      const compiled = await validateAgentCode(nextSpec.generatedCode);
      if (!compiled.ok) validationErrors.push(...compiled.errors.map((error) => `generatedCode: ${error}`));
    }
    if (validationErrors.length) throw new Error(`invalid draft patch: ${validationErrors.slice(0, 12).join("; ")}`);

    const specs = base.map((draft) => draft.slug === target.slug ? nextSpec : draft.spec);
    const persisted = await this.persistVersion(domain, specs, undefined, {
      expectedLatestVersionId: baseVersionId,
    });
    if (!persisted.versionId || persisted.count !== specs.length) throw new Error("failed to persist patched draft version");
    return {
      domain,
      versionId: persisted.versionId,
      baseVersionId,
      changedSlug: target.slug,
      drafts: await this.getVersion(domain, persisted.versionId),
      regressionReady: false,
      evidenceEffect: DRAFT_EDIT_EVIDENCE_EFFECT,
    };
  }

  /** Materialize fresh sandbox evidence for one exact immutable version as a
   * new immutable version. The base version's regression pointer is never
   * inspected or copied; callers must provide evidence from the just-finished
   * disposable attempt. */
  async createSandboxedVersion(
    domain: string,
    baseVersionId: string,
    regression: AgentDraftRegressionEvidence,
  ): Promise<SandboxedDraftVersion> {
    const base = await this.getVersion(domain, baseVersionId);
    if (!base.length) throw new Error(`draft version not found: ${baseVersionId}`);
    if (base.some((draft) => draft.versionId !== baseVersionId)) {
      throw new Error("draft version identity mismatch");
    }
    const specs = base.map((draft) => JSON.parse(JSON.stringify(draft.spec)) as GeneratedAgentSpec);
    await this.requireCurrentVersion(domain, baseVersionId);
    const persisted = await this.persistVersion(domain, specs, regression, {
      requireRegressionValidation: true,
      publishLatest: false,
      expectedLatestVersionId: baseVersionId,
    });
    if (!persisted.versionId || persisted.count !== specs.length) {
      throw new Error("failed to persist sandboxed draft version");
    }
    const drafts = await this.getVersion(domain, persisted.versionId);
    if (drafts.length !== specs.length || drafts.some((draft) => !draft.regression)) {
      throw new Error("sandboxed draft version is missing regression pointers");
    }
    return {
      domain,
      versionId: persisted.versionId,
      baseVersionId,
      drafts,
      regressionReady: false,
      regressionStatus: "pending_replay",
    };
  }

  /** Publish a sandbox-derived version only after its exact immutable replay
   * has been durably marked ready. A concurrent edit leaves this version in
   * history for audit but cannot move the current projection backwards. */
  async publishValidatedVersion(
    domain: string,
    versionId: string,
    expectedBaseVersionId: string,
  ): Promise<void> {
    const drafts = await this.getVersion(domain, versionId);
    if (!drafts.length || drafts.some((draft) => draft.versionId !== versionId)) {
      throw new Error(`draft version not found: ${versionId}`);
    }
    const summary = (await this.listVersions(domain)).find((entry) => entry.versionId === versionId);
    if (!summary?.regressionReady || summary.regressionStatus !== "ready") {
      throw new Error(`sandboxed draft regression is not ready: ${versionId}`);
    }
    await this.publishVersionProjection(
      domain,
      versionId,
      drafts.map((draft) => draft.spec),
      expectedBaseVersionId,
    );
  }

  /** Review receipts live beside (never inside) immutable version bundles. */
  async writeReviewReceipt(domain: string, receiptId: string, document: unknown): Promise<void> {
    if (!this.acceptsDomain(domain) || !/^review-[a-f0-9-]{8,80}$/.test(receiptId)) throw new Error("invalid review receipt identity");
    const dir = path.join(this.dir(domain), "reviews");
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    await writeDurableAtomic(path.join(dir, `${receiptId}.json`), `${JSON.stringify(document, null, 2)}\n`, true);
  }

  async readReviewReceipt<T>(domain: string, receiptId: string): Promise<T | null> {
    if (!this.acceptsDomain(domain) || !/^review-[a-f0-9-]{8,80}$/.test(receiptId)) return null;
    try {
      return JSON.parse(await fs.readFile(path.join(this.dir(domain), "reviews", `${receiptId}.json`), "utf8")) as T;
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }

  /** #P1b — read back the persisted DEPLOYABLE .ts for a draft (the actual function code to hand the
   *  user). Falls back to rendering on the fly from the .json spec if the .ts wasn't written (older
   *  drafts). null if the draft doesn't exist. */
  async getCode(domain: string, slug: string, versionId?: string): Promise<string | null> {
    if (!this.acceptsDomain(domain)) return null;
    const s = safe(slug);
    // A deletion tombstone applies to the mutable current projection only.
    // Exact version reads are immutable audit/replay reads and must survive it.
    if (!versionId && await this.tombstoned(domain, s)) return null;
    const dirs = versionId
      ? (VERSION_ID.test(versionId) ? [this.dir(domain)] : [])
      : [this.dir(domain), this.oldScopedDir(domain), this.legacyDir(domain)].filter((d, i, a): d is string => !!d && a.indexOf(d) === i);
    for (const dir of dirs) {
      let draft: ScopedAgentDraft;
      let draftDir = versionId ? path.join(dir, "versions", versionId, "agents") : path.join(dir, "latest", "agents");
      try {
        draft = JSON.parse(await fs.readFile(path.join(draftDir, `${s}.json`), "utf8")) as ScopedAgentDraft;
        if (this.scope && !this.validScopedDraft(draft, domain)) continue;
      } catch (error) {
        if (!isMissing(error)) throw new Error(`cannot read factory draft ${path.join(draftDir, `${s}.json`)}`, { cause: error });
        if (versionId) continue;
        // Only fall back to flat storage when this directory has no version pointer.
        try {
          await fs.lstat(path.join(dir, "latest"));
          continue;
        } catch (latestError) {
          if (!isMissing(latestError)) throw latestError;
        }
        draftDir = dir;
        try {
          draft = JSON.parse(await fs.readFile(path.join(draftDir, `${s}.json`), "utf8")) as ScopedAgentDraft;
          if (this.scope && !this.validScopedDraft(draft, domain)) continue;
        } catch (fallbackError) {
          if (isMissing(fallbackError)) continue;
          throw new Error(`cannot read factory draft ${path.join(draftDir, `${s}.json`)}`, { cause: fallbackError });
        }
      }
      try {
        return await fs.readFile(path.join(draftDir, `${s}.ts`), "utf8");
      } catch (error) {
        if (!isMissing(error)) throw error;
        return renderTsFunctionModule(draft.spec);
      }
    }
    return null;
  }

  /** Delete one generated-function draft (user declined it before promotion). Slug is sanitized
   *  the same way it was written; returns false if it wasn't there. Also removes the sibling .ts. */
  async delete(domain: string, slug: string): Promise<boolean> {
    if (!this.acceptsDomain(domain)) return false;
    const s = safe(slug);
    const exists = (await this.list(domain)).some((draft) => draft.slug === s);
    if (!exists) return false;
    // Immutable versions are audit evidence. Declining a draft writes a
    // tombstone rather than deleting/tampering with its approved bundle.
    const tombstoneDir = path.join(this.dir(domain), ".deleted");
    await fs.mkdir(tombstoneDir, { recursive: true });
    await writeDurableAtomic(path.join(tombstoneDir, s), `${new Date().toISOString()}\n`);
    const dirs = [this.dir(domain), this.oldScopedDir(domain), this.legacyDir(domain)].filter((d, i, a): d is string => !!d && a.indexOf(d) === i);
    for (const dir of dirs) {
      let removedProjection = false;
      for (const ext of ["json", "ts"]) {
        try {
          await fs.unlink(path.join(dir, `${s}.${ext}`));
          removedProjection = true;
        } catch (error) {
          if (!isMissing(error)) throw error;
        }
      }
      if (removedProjection) await syncDirectory(dir);
    }
    return true;
  }

  /** Promotion gate: locate the immutable suite referenced by each selected
   * draft, validate its fingerprint/cassettes and re-execute the persisted
   * modules. Legacy drafts without a suite fail closed and must be regenerated. */
  async replayRegression(
    domain: string,
    slugs: string[],
    versionId?: string,
    internal: {
      allowPendingValidation?: boolean;
      /** Trusted promoted-replay override. It reads an immutable promotion
       * capsule instead of the short-lived draft fixture store. */
      materializeTestPayload?: RegressionReplayOptions["materializeTestPayload"];
      codeActContainerTransport?: RegressionReplayOptions["codeActContainerTransport"];
      codeActCandidateImage?: string;
      /** Only the signed export replay coordinator may set this after it has
       * verified the independent export manifest and file inventory. */
      cassetteTrust?: RegressionReplayOptions["cassetteTrust"];
    } = {},
  ): Promise<RegressionReplayResult> {
    if (versionId) {
      const validation = await this.regressionValidationState(domain, versionId);
      if (validation.required) {
        if (internal.allowPendingValidation && validation.status !== "pending_replay") {
          return {
            pass: false,
            artifact: "",
            results: [],
            errors: [`regression validation is already ${validation.status}: ${versionId}`],
          };
        }
        if (!internal.allowPendingValidation && validation.status !== "ready") {
          return {
            pass: false,
            artifact: "",
            results: [],
            errors: [`regression version is not promotable (${validation.status}): ${versionId}`],
          };
        }
      }
    }
    const drafts = versionId ? await this.getVersion(domain, versionId) : await this.list(domain);
    const selected = drafts.filter((draft) => slugs.includes(draft.slug));
    const missing = slugs.filter((slug) => !selected.some((draft) => draft.slug === slug));
    if (missing.length) {
      return { pass: false, artifact: "", results: [], errors: [`drafts not found: ${missing.join(", ")}`] };
    }
    if (!versionId) {
      for (const selectedVersion of new Set(selected.map((draft) => draft.versionId).filter((value): value is string => Boolean(value)))) {
        const validation = await this.regressionValidationState(domain, selectedVersion);
        if (validation.required && validation.status !== "ready") {
          return {
            pass: false,
            artifact: "",
            results: [],
            errors: [`regression version is not promotable (${validation.status}): ${selectedVersion}`],
          };
        }
      }
    }
    const missingArtifacts = selected.filter((draft) => !draft.versionId || !draft.regression);
    if (missingArtifacts.length) {
      return {
        pass: false,
        artifact: "",
        results: [],
        errors: [`drafts have no replayable regression artifact: ${missingArtifacts.map((draft) => draft.slug).join(", ")}`],
      };
    }
    const byArtifact = new Map<string, typeof selected>();
    for (const draft of selected) {
      const ref = draft.regression!.artifact;
      (byArtifact.get(ref) ?? byArtifact.set(ref, []).get(ref)!).push(draft);
    }
    const dirs = versionId
      ? [this.dir(domain)]
      : [this.dir(domain), this.oldScopedDir(domain), this.legacyDir(domain)].filter((d, i, a): d is string => !!d && a.indexOf(d) === i);
    const combined: RegressionReplayResult = {
      pass: true,
      promotionEvidenceReady: true,
      promotionEvidenceErrors: [],
      artifact: "",
      results: [],
      errors: [],
      effectiveEntryEvents: [],
    };
    const fixtureAssetStore = this.scope
      ? (this.fixtureAssetStore ?? new FsFactoryFixtureAssetStore())
      : null;
    for (const [relativeArtifact, grouped] of byArtifact) {
      let artifactPath: string | null = null;
      for (const dir of dirs) {
        const candidate = path.resolve(dir, relativeArtifact);
        const base = path.resolve(dir);
        if (candidate !== base && !candidate.startsWith(`${base}${path.sep}`)) continue;
        try {
          await fs.access(candidate);
          artifactPath = candidate;
          break;
        } catch (error) {
          if (!isMissing(error)) throw error;
        }
      }
      if (!artifactPath) {
        combined.errors.push(`regression artifact unavailable: ${relativeArtifact}`);
        combined.pass = false;
        continue;
      }
      // The canonical evidence fingerprint covers the whole delivery version,
      // not only the slugs selected for promotion. Replay every agent in that
      // referenced suite so an unselected sibling cannot drift unnoticed.
      const replayOptions: RegressionReplayOptions = {
        ...(internal.codeActContainerTransport
          ? { codeActContainerTransport: internal.codeActContainerTransport }
          : {}),
        ...(internal.codeActCandidateImage
          ? { codeActCandidateImage: internal.codeActCandidateImage }
          : {}),
        ...(internal.cassetteTrust
          ? { cassetteTrust: internal.cassetteTrust }
          : {}),
        ...(internal.materializeTestPayload
          ? { materializeTestPayload: internal.materializeTestPayload }
          : fixtureAssetStore && this.scope
          ? {
              materializeTestPayload: async (input) => {
                if (input.domain !== domain || input.domain !== (this.scope!.ontologyDomainId ?? domain)) {
                  throw new Error("binary fixture replay domain is outside the draft-store scope");
                }
                return materializeFactoryFixturePayload({
                  ...input,
                  tenantId: this.scope!.tenantId,
                  store: fixtureAssetStore,
                });
              },
            }
          : {}),
      };
      const replay = await replayRegressionArtifact(
        artifactPath,
        undefined,
        Object.keys(replayOptions).length ? replayOptions : undefined,
      );
      combined.artifact = combined.artifact ? `${combined.artifact},${replay.artifact}` : replay.artifact;
      if (combined.versionId && replay.versionId && combined.versionId !== replay.versionId) {
        combined.errors.push("regression version differs across selected artifacts");
      }
      combined.versionId ??= replay.versionId;
      if (
        combined.evidenceFingerprint
        && replay.evidenceFingerprint
        && combined.evidenceFingerprint !== replay.evidenceFingerprint
      ) {
        combined.errors.push("sandbox evidence fingerprint differs across selected artifacts");
      }
      combined.evidenceFingerprint ??= replay.evidenceFingerprint;
      if (
        combined.authoritativeOntology
        && replay.authoritativeOntology
        && canonicalEvidenceJson(combined.authoritativeOntology)
          !== canonicalEvidenceJson(replay.authoritativeOntology)
      ) {
        combined.errors.push("authoritative ontology evidence differs across selected artifacts");
      }
      combined.authoritativeOntology ??= replay.authoritativeOntology;
      if (
        combined.suiteFingerprint
        && replay.suiteFingerprint
        && combined.suiteFingerprint !== replay.suiteFingerprint
      ) {
        combined.errors.push("regression suite fingerprint differs across selected artifacts");
      }
      combined.suiteFingerprint ??= replay.suiteFingerprint;
      if (
        combined.sandboxCleanupReceiptHash &&
        replay.sandboxCleanupReceiptHash &&
        combined.sandboxCleanupReceiptHash !== replay.sandboxCleanupReceiptHash
      ) {
        combined.errors.push("sandbox cleanup receipt hash differs across selected artifacts");
      }
      combined.sandboxCleanupReceiptHash ??= replay.sandboxCleanupReceiptHash;
      for (const [label, current, incoming] of [
        ["sandbox cleanup receipt", combined.sandboxCleanupReceipt, replay.sandboxCleanupReceipt],
        ["sandbox function registration", combined.sandboxBrokerRegistration, replay.sandboxBrokerRegistration],
        ["sandbox execution receipt", combined.sandboxExecutionReceipt, replay.sandboxExecutionReceipt],
        ["sandbox model usage", combined.sandboxModelUsage, replay.sandboxModelUsage],
      ] as const) {
        if (
          current !== undefined
          && incoming !== undefined
          && canonicalEvidenceJson(current) !== canonicalEvidenceJson(incoming)
        ) {
          combined.errors.push(`${label} differs across selected artifacts`);
        }
      }
      combined.sandboxCleanupReceipt ??= replay.sandboxCleanupReceipt;
      combined.sandboxBrokerRegistration ??= replay.sandboxBrokerRegistration;
      combined.sandboxExecutionReceipt ??= replay.sandboxExecutionReceipt;
      combined.sandboxModelUsage ??= replay.sandboxModelUsage;
      if (
        combined.sandboxAppId
        && replay.sandboxAppId
        && combined.sandboxAppId !== replay.sandboxAppId
      ) {
        combined.errors.push("sandbox app identity differs across selected artifacts");
      }
      combined.sandboxAppId ??= replay.sandboxAppId;
      if (
        combined.committedManifestFunctionIds
        && replay.committedManifestFunctionIds
        && canonicalEvidenceJson([...combined.committedManifestFunctionIds].sort())
          !== canonicalEvidenceJson([...replay.committedManifestFunctionIds].sort())
      ) {
        combined.errors.push("sandbox registered function set differs across selected artifacts");
      }
      combined.committedManifestFunctionIds ??= replay.committedManifestFunctionIds;
      combined.promotionEvidenceReady = combined.promotionEvidenceReady === true
        && replay.promotionEvidenceReady === true;
      combined.promotionEvidenceErrors = [
        ...(combined.promotionEvidenceErrors ?? []),
        ...(replay.promotionEvidenceErrors ?? []),
      ];
      if (
        combined.sandboxExternalLiveCalls !== undefined &&
        combined.sandboxExternalLiveCalls !== replay.sandboxExternalLiveCalls
      ) {
        combined.errors.push("sandbox external live-call count differs across selected artifacts");
      }
      if (combined.sandboxExternalLiveCalls === undefined) {
        combined.sandboxExternalLiveCalls = replay.sandboxExternalLiveCalls;
      }
      if (
        combined.sandboxReplayEvidenceComplete !== undefined &&
        combined.sandboxReplayEvidenceComplete !== replay.sandboxReplayEvidenceComplete
      ) {
        combined.errors.push("sandbox replay evidence completeness differs across selected artifacts");
      }
      if (combined.sandboxReplayEvidenceComplete === undefined) {
        combined.sandboxReplayEvidenceComplete = replay.sandboxReplayEvidenceComplete;
      }
      combined.sandboxReplayReceipts = [
        ...(combined.sandboxReplayReceipts ?? []),
        ...(replay.sandboxReplayReceipts ?? []),
      ];
      combined.effectiveEntryEvents = [
        ...new Set([
          ...(combined.effectiveEntryEvents ?? []),
          ...(replay.effectiveEntryEvents ?? []),
        ]),
      ].sort();
      combined.results.push(...replay.results);
      combined.errors.push(...replay.errors);
      for (const draft of grouped) {
        if (replay.versionId !== draft.versionId) {
          combined.errors.push(`${draft.slug}: regression artifact version mismatch`);
        }
        if (!replay.results.some((entry) => entry.slug === draft.slug)) {
          combined.errors.push(`${draft.slug}: regression artifact does not cover selected draft`);
        }
        if (draft.regression!.evidenceFingerprint !== replay.evidenceFingerprint) {
          combined.errors.push(`${draft.slug}: evidence fingerprint pointer mismatch`);
        }
        if (draft.regression!.suiteFingerprint !== replay.suiteFingerprint) {
          combined.errors.push(`${draft.slug}: suite fingerprint pointer mismatch`);
        }
        if (draft.regression!.cleanupReceiptHash !== replay.sandboxCleanupReceiptHash) {
          combined.errors.push(`${draft.slug}: sandbox cleanup receipt pointer mismatch`);
        }
        if (
          !draft.regression!.authoritativeOntology
          || !replay.authoritativeOntology
          || canonicalEvidenceJson(draft.regression!.authoritativeOntology)
            !== canonicalEvidenceJson(replay.authoritativeOntology)
        ) {
          combined.errors.push(`${draft.slug}: authoritative ontology pointer mismatch`);
        }
      }
      combined.pass = combined.pass && replay.pass;
    }
    combined.pass = combined.pass && combined.errors.length === 0;
    return combined;
  }

  /** One-shot validation for a just-materialized sandbox version. The
   * immutable evidence bundle is retained whether replay passes or fails;
   * only a separate durable status receipt changes. A missing/invalid receipt
   * is fail-closed in listVersions and every normal promotion replay. */
  async validateSandboxedRegression(
    domain: string,
    slugs: string[],
    versionId: string,
  ): Promise<RegressionReplayResult> {
    const state = await this.regressionValidationState(domain, versionId);
    if (!state.required || state.status !== "pending_replay") {
      return {
        pass: false,
        artifact: "",
        results: [],
        errors: [`sandbox regression version cannot be validated from ${state.status}: ${versionId}`],
      };
    }
    let replay: RegressionReplayResult;
    try {
      replay = await this.replayRegression(domain, slugs, versionId, { allowPendingValidation: true });
    } catch {
      // Do not persist parser/runtime exception text: it may contain fixture
      // data or local paths. The immutable bundle remains available for audit.
      replay = {
        pass: false,
        artifact: "",
        results: [],
        errors: ["regression replay execution failed"],
      };
    }
    await this.writeRegressionValidationStatus(domain, versionId, replay);
    return replay;
  }
}
