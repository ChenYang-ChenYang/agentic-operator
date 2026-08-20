import { createHash } from "node:crypto";
import { isSecretShapedString } from "@agentic/agent-factory";
import { canonicalEvidenceJson } from "@agentic/shared";
import type {
  OntoCodeArtifact,
  OntoCodeArtifactVersion,
  OntoCodeBuildSession,
  OntoCodeChangeSet,
  OntoCodeEvidenceRecord,
  OntoCodeProject,
} from "@agentic/contracts";
import {
  getOntoCodeArtifactVersion,
  getOntoCodeChangeSet,
  getOntoCodeEvidenceRecord,
  OntoCodeStoreError,
  type OntoCodeStoreContext,
} from "./ontocode-session-store";

const SHA256 = /^[a-f0-9]{64}$/;

/** #CONTEXT-HONESTY —— 上下文字节预算的三个旋钮，全部具名 + 可用环境变量覆盖。
 *
 *  历史上这两个常量是写死的，而且 `maxRefBytes` 这一刀切得【完全无声】：
 *  实测线上 9 次 context_compile 里有 4 次把深度分析产物从 220_503 / 224_980 /
 *  244_919 字节直接切成 24_000 字节（丢掉 89.1% / 89.3% / 90.2%），清单里只留下
 *  `truncated: true` 和 `includedBytes: 24000`——没有任何分母，下游根本分不清
 *  「24_000 里丢了 100 字节」和「24_000 里丢了 220_919 字节」。
 *
 *  ⚠ 与 planner 的耦合：ontocode-assistant-planner.ts 的 CompiledContextSchema
 *  把单条 ref 的 content 限死在 24_000 【字符】且是 strict parse。把
 *  ONTOCODE_CONTEXT_MAX_REF_BYTES 调到 24_000 以上会让 planner 直接 parse 失败
 *  （响亮地失败，不是静默截断）。要放大得两边一起动。 */
const DEFAULT_MAX_CONTEXT_BYTES = 48_000;
const DEFAULT_MAX_REF_BYTES = 24_000;
/**
 * 一条引用如果连这么多字节都分不到，它进入上下文的唯一作用就是骗人：模型看到的是
 * 一个从中间被切断、结构已经不成立的碎片。与其静默塞碎片，不如带着确切数字拒绝，
 * 让调用方知道该丢掉哪条引用。
 */
const DEFAULT_MIN_REF_BYTES = 512;
const MAX_CONTEXT_BYTES_ENV = "ONTOCODE_CONTEXT_MAX_BYTES";
const MAX_REF_BYTES_ENV = "ONTOCODE_CONTEXT_MAX_REF_BYTES";
const MIN_REF_BYTES_ENV = "ONTOCODE_CONTEXT_MIN_REF_BYTES";

function envPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  // 一个写坏的环境变量绝不能把预算悄悄关掉——回退到具名默认值。
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function resolveOntoCodeContextByteBudgets(): {
  maxBytes: number;
  maxRefBytes: number;
} {
  return {
    maxBytes: envPositiveInt(MAX_CONTEXT_BYTES_ENV, DEFAULT_MAX_CONTEXT_BYTES),
    maxRefBytes: envPositiveInt(MAX_REF_BYTES_ENV, DEFAULT_MAX_REF_BYTES),
  };
}

export type OntoCodeCompiledContextRefKind =
  | "ontology"
  | "artifact"
  | "evidence"
  | "changeset";

/**
 * `ref_cap` —— 这条引用自己太大，超过单引用上限；补救办法是把它单独取回或分页。
 * `context_budget` —— 这条引用本身放得下，是前面的引用把整体预算吃光了；补救办法
 * 是丢掉前面某条引用。两者要求的动作完全不同，所以必须分开报。
 */
export type OntoCodeContextTruncationReason = "ref_cap" | "context_budget";

export interface OntoCodeCompiledContextRef {
  kind: OntoCodeCompiledContextRefKind;
  requestedRef: string;
  canonicalRef: string;
  contentHash: string;
  content: string;
  truncated: boolean;
  redacted: boolean;
  /** 截断前的真实字节数——「不许静默截断」要求每个上限都报出真实的原始计数。 */
  rawBytes: number;
  /** 实际进入上下文的字节数（含截断标记本身）。 */
  includedBytes: number;
  /** 没有进入上下文的字节数。 */
  droppedBytes: number;
  truncationReason: OntoCodeContextTruncationReason | null;
  artifactId: string | null;
  artifactVersionId: string | null;
  evidenceId: string | null;
  changeSetId: string | null;
  metadata: Record<string, unknown>;
}

export interface OntoCodeCompiledContext {
  schema: "ontocode-compiled-context/v1";
  contextHash: string;
  sessionId: string;
  sessionRevision: number;
  ontologySnapshotHash: string | null;
  refs: OntoCodeCompiledContextRef[];
  manifest: {
    schema: "ontocode-context-manifest/v1";
    totalBytes: number;
    maxBytes: number;
    maxRefBytes: number;
    /** 所有引用截断前的字节总和。 */
    requestedBytes: number;
    /** 源文件里没有进入上下文的字节总和。只发生截断时
     *  `totalBytes + droppedBytes === requestedBytes`；被脱敏的引用是「替换」而不是
     *  「截断」，占位符自身也算进 totalBytes，所以那种情况下这个等式不成立。 */
    droppedBytes: number;
    truncatedRefs: number;
    refs: Array<{
      kind: OntoCodeCompiledContextRefKind;
      requestedRef: string;
      canonicalRef: string;
      contentHash: string;
      includedBytes: number;
      rawBytes: number;
      droppedBytes: number;
      truncationReason: OntoCodeContextTruncationReason | null;
      truncated: boolean;
      redacted: boolean;
    }>;
  };
}

interface OntoCodeStageArtifactSummary {
  artifact: {
    id: string;
    logicalName: string;
  };
  latestVersion: {
    id: string;
    createdAt: number;
  };
}

/**
 * Assistant clients may explicitly pin exact refs. When they do not, keep
 * follow-up questions grounded by attaching the newest durable stage outputs.
 * The server owns this fallback so a slow Artifact refetch or a non-web client
 * cannot silently send a 0-byte Blueprint explanation request.
 */
export function resolveOntoCodeAssistantContextRefs(
  requestedRefs: string[],
  artifacts: OntoCodeStageArtifactSummary[],
): string[] {
  if (requestedRefs.length > 0) return [...requestedRefs];

  const latest = new Map<
    "analysis" | "scope" | "blueprint",
    OntoCodeStageArtifactSummary
  >();
  for (const item of artifacts) {
    const match = item.artifact.logicalName.match(
      /(?:^|\/)(ontology_analysis|analysis|scope|blueprint)(?:\/|$)/u,
    );
    if (!match) continue;
    const rawKind = match[1]!;
    const kind =
      rawKind === "ontology_analysis" || rawKind === "analysis"
        ? "analysis"
        : rawKind === "scope"
          ? "scope"
          : "blueprint";
    const previous = latest.get(kind);
    if (
      !previous ||
      item.latestVersion.createdAt > previous.latestVersion.createdAt
    ) {
      latest.set(kind, item);
    }
  }

  return (["blueprint", "scope", "analysis"] as const).flatMap((kind) => {
    const item = latest.get(kind);
    return item
      ? [`artifact:${item.artifact.id}@${item.latestVersion.id}`]
      : [];
  });
}

export class OntoCodeContextCompilerError extends Error {
  constructor(
    readonly code:
      | "ontocode_context_ref_invalid"
      | "ontocode_context_ref_session_mismatch"
      | "ontocode_context_budget_exceeded",
    message: string,
    readonly statusCode: number,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "OntoCodeContextCompilerError";
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * 按 UTF-8 边界截断，绝不产生半个字符。
 *
 * 旧实现是 `Buffer.subarray(0, allowed).toString("utf8")`，注释还写着「keeps the
 * model context inside the hard byte budget」——恰恰相反：解码一个被切断的多字节
 * 序列会得到 U+FFFD，它自己就占 3 字节。实测切 400 字节的中文得到 402 字节，
 * 那个专门用来兜住预算的上限反而被它自己冲破了，而且模型读到的是一串乱码尾巴。
 */
function utf8HeadSlice(raw: string, allowedBytes: number): string {
  if (allowedBytes <= 0) return "";
  const buffer = Buffer.from(raw, "utf8");
  if (buffer.length <= allowedBytes) return raw;
  let end = allowedBytes;
  // 0b10xxxxxx 是续字节：往前退到一个字符的起始字节为止。
  while (end > 0 && (buffer[end]! & 0xc0) === 0x80) end -= 1;
  return buffer.subarray(0, end).toString("utf8");
}

const TRUNCATION_REASON_TEXT: Record<OntoCodeContextTruncationReason, string> =
  {
    ref_cap: "单条引用的字节上限",
    context_budget: "整体上下文预算已被前面的引用占满",
  };

/**
 * 内联截断标记。清单里报得再准也救不了模型——planner 是把 `content` 原样塞进
 * 提示词的，模型看到的就是一段从中间断掉的 JSON。唯一的警告如果只活在兄弟字段
 * 里，模型完全可能读了 10% 却以为自己读完了整篇。标记本身计入预算。
 */
function truncationMarker(
  canonicalRef: string,
  rawBytes: number,
  includedBytes: number,
  reason: OntoCodeContextTruncationReason,
): string {
  const dropped = Math.max(0, rawBytes - includedBytes);
  const percent =
    rawBytes > 0 ? Math.floor((includedBytes / rawBytes) * 100) : 0;
  return (
    `\n…[上下文截断｜原文 ${rawBytes} 字节，这里只有开头 ${includedBytes} 字节（约 ${percent}%），` +
    `缺 ${dropped} 字节；原因：${TRUNCATION_REASON_TEXT[reason]}。` +
    `这不是完整文档，缺失部分请按引用 ${canonicalRef} 单独取回，不要据此断言文档里「没有」什么。]`
  );
}

interface BoundedContent {
  content: string;
  bytes: number;
  rawBytes: number;
  truncated: boolean;
  redacted: boolean;
  reason: OntoCodeContextTruncationReason | null;
}

function boundedContent(
  raw: string,
  canonicalRef: string,
  remainingBytes: number,
  maxRefBytes: number,
): BoundedContent | { exceeded: true; rawBytes: number } {
  const rawBytes = Buffer.byteLength(raw, "utf8");
  if (isSecretShapedString(raw)) {
    const content = "[REDACTED_SECRET_SHAPED_CONTEXT]";
    return {
      content,
      bytes: Buffer.byteLength(content, "utf8"),
      rawBytes,
      truncated: false,
      redacted: true,
      reason: null,
    };
  }
  const allowed = Math.max(0, Math.min(remainingBytes, maxRefBytes));
  if (rawBytes <= allowed) {
    return {
      content: raw,
      bytes: rawBytes,
      rawBytes,
      truncated: false,
      redacted: false,
      reason: null,
    };
  }
  // 放不下时，先说清楚是谁卡住的：是这条引用自己太大，还是前面的引用把预算吃光了。
  const reason: OntoCodeContextTruncationReason =
    remainingBytes < maxRefBytes ? "context_budget" : "ref_cap";
  const minRefBytes = envPositiveInt(MIN_REF_BYTES_ENV, DEFAULT_MIN_REF_BYTES);
  if (allowed < minRefBytes) return { exceeded: true, rawBytes };

  // 标记里的数字取决于正文长度，正文长度又取决于标记长度。每轮按实际溢出量收缩
  // 正文预算，单调下降，几轮内必收敛；收敛不了就按最后一次的预算硬切。
  let bodyBudget = allowed;
  let body = "";
  let marker = "";
  for (let attempt = 0; attempt < 8; attempt += 1) {
    body = utf8HeadSlice(raw, bodyBudget);
    const bodyBytes = Buffer.byteLength(body, "utf8");
    marker = truncationMarker(canonicalRef, rawBytes, bodyBytes, reason);
    const overflow = bodyBytes + Buffer.byteLength(marker, "utf8") - allowed;
    if (overflow <= 0) break;
    bodyBudget = bodyBytes - overflow;
    if (bodyBudget <= 0) return { exceeded: true, rawBytes };
  }
  const content = `${body}${marker}`;
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > allowed) return { exceeded: true, rawBytes };
  return { content, bytes, rawBytes, truncated: true, redacted: false, reason };
}

function requireSameSession(
  expectedSessionId: string,
  actualSessionId: string,
  requestedRef: string,
): void {
  if (actualSessionId === expectedSessionId) return;
  throw new OntoCodeContextCompilerError(
    "ontocode_context_ref_session_mismatch",
    "The referenced OntoCode object does not belong to this Session",
    409,
    { requestedRef },
  );
}

/**
 * Keep the tenant-hiding storage boundary scoped to the one lookup that is
 * actually resolving a context reference. The Assistant route also performs
 * later Session/Command/Job writes; treating every `OntoCodeStoreError` from
 * that wider turn as a missing attachment both lies in the reasoning log and
 * hides the real actionable error.
 */
function loadStoredContextReference<T>(load: () => T): T {
  try {
    return load();
  } catch (error) {
    if (error instanceof OntoCodeStoreError) {
      throw new OntoCodeContextCompilerError(
        "ontocode_context_ref_invalid",
        "One or more selected context references are unavailable in this Tenant and Session",
        error.statusCode === 404 ? 404 : error.statusCode,
      );
    }
    throw error;
  }
}

function artifactContext(
  ctx: Pick<OntoCodeStoreContext, "tenantId">,
  sessionId: string,
  requestedRef: string,
  artifactIdHint: string | null,
  versionId: string,
): {
  canonicalRef: string;
  contentHash: string;
  rawContent: string;
  artifact: OntoCodeArtifact;
  version: OntoCodeArtifactVersion;
  metadata: Record<string, unknown>;
} {
  const result = loadStoredContextReference(() =>
    getOntoCodeArtifactVersion(ctx, versionId),
  );
  requireSameSession(sessionId, result.artifact.sessionId, requestedRef);
  if (artifactIdHint && artifactIdHint !== result.artifact.id) {
    throw new OntoCodeContextCompilerError(
      "ontocode_context_ref_invalid",
      "The Artifact id and Artifact Version id in the context reference do not match",
      409,
      { requestedRef },
    );
  }
  return {
    canonicalRef: `artifact:${result.artifact.id}@${result.version.id}`,
    contentHash: result.version.blobHash.replace(/^sha256:/, ""),
    rawContent: result.content,
    artifact: result.artifact,
    version: result.version,
    metadata: {
      logicalName: result.artifact.logicalName,
      kind: result.artifact.kind,
      semanticPath: result.artifact.semanticPath,
      version: result.version.version,
      contentType: result.version.contentType,
      sizeBytes: result.version.sizeBytes,
      blobHash: result.version.blobHash,
    },
  };
}

function evidenceContext(
  ctx: Pick<OntoCodeStoreContext, "tenantId">,
  sessionId: string,
  requestedRef: string,
  evidenceId: string,
): {
  canonicalRef: string;
  contentHash: string;
  rawContent: string;
  evidence: OntoCodeEvidenceRecord;
  metadata: Record<string, unknown>;
} {
  const evidence = loadStoredContextReference(() =>
    getOntoCodeEvidenceRecord(ctx, evidenceId),
  );
  requireSameSession(sessionId, evidence.sessionId, requestedRef);
  const rawContent = canonicalEvidenceJson({
    kind: evidence.kind,
    outcome: evidence.outcome,
    subjectType: evidence.subjectType,
    subjectId: evidence.subjectId,
    subjectDigest: evidence.subjectDigest,
    dependencySet: evidence.dependencySet,
    validityPredicate: evidence.validityPredicate,
    refs: evidence.refs,
    summary: evidence.summary,
    producer: evidence.producer,
    createdAt: evidence.createdAt,
  });
  return {
    canonicalRef: `evidence:${evidence.id}`,
    contentHash: sha256(rawContent),
    rawContent,
    evidence,
    metadata: {
      kind: evidence.kind,
      outcome: evidence.outcome,
      subjectType: evidence.subjectType,
      subjectId: evidence.subjectId,
      subjectDigest: evidence.subjectDigest,
    },
  };
}

function changeSetContext(
  ctx: Pick<OntoCodeStoreContext, "tenantId">,
  sessionId: string,
  requestedRef: string,
  changeSetId: string,
): {
  canonicalRef: string;
  contentHash: string;
  rawContent: string;
  changeSet: OntoCodeChangeSet;
  metadata: Record<string, unknown>;
} {
  const result = loadStoredContextReference(() =>
    getOntoCodeChangeSet(ctx, changeSetId),
  );
  requireSameSession(sessionId, result.changeSet.sessionId, requestedRef);
  const rawContent = canonicalEvidenceJson({
    changeSet: result.changeSet,
    operations: result.operations,
  });
  return {
    canonicalRef: `changeset:${result.changeSet.id}`,
    contentHash: sha256(rawContent),
    rawContent,
    changeSet: result.changeSet,
    metadata: {
      status: result.changeSet.status,
      summary: result.changeSet.summary,
      operationCount: result.operations.length,
      expectedSessionRevision: result.changeSet.expectedSessionRevision,
    },
  };
}

export function compileOntoCodeContext(input: {
  ctx: Pick<OntoCodeStoreContext, "tenantId">;
  project: OntoCodeProject;
  session: OntoCodeBuildSession;
  requestedRefs: string[];
  /** #ONTOLOGY-FACTS —— 本 Session 快照的结构化摘要（对象/动作/事件/规则/关系图/缺口）。
   *
   *  以前这个引用只解析出 {domain, snapshotHash, trust} 三个字段——助手手上一条领域事实都没有，
   *  于是「这个域有哪些动作」「哪些规则会卡住流程」这类问题只能去跑一个完整的 harness 作业，
   *  或者干脆瞎答。摘要由调用方算好传进来：这个编译器是纯函数，I/O 不属于它。
   *  缺省仍然只带身份信息——【没拿到就说没拿到】，绝不假装看过。 */
  ontologyDigest?: string;
  maxBytes?: number;
  maxRefBytes?: number;
}): OntoCodeCompiledContext {
  const budgets = resolveOntoCodeContextByteBudgets();
  const maxBytes = input.maxBytes ?? budgets.maxBytes;
  const maxRefBytes = input.maxRefBytes ?? budgets.maxRefBytes;
  if (maxBytes <= 0 || maxRefBytes <= 0) {
    throw new OntoCodeContextCompilerError(
      "ontocode_context_budget_exceeded",
      "OntoCode context byte budgets must be positive",
      500,
    );
  }

  const seen = new Set<string>();
  const refs: OntoCodeCompiledContextRef[] = [];
  let totalBytes = 0;

  for (const rawRef of input.requestedRefs) {
    const requestedRef = rawRef.normalize("NFKC").trim();
    if (!requestedRef || seen.has(requestedRef)) continue;
    seen.add(requestedRef);

    let resolved:
      | {
          kind: "ontology";
          canonicalRef: string;
          contentHash: string;
          rawContent: string;
          metadata: Record<string, unknown>;
          artifactId: null;
          artifactVersionId: null;
          evidenceId: null;
          changeSetId: null;
        }
      | {
          kind: "artifact";
          canonicalRef: string;
          contentHash: string;
          rawContent: string;
          metadata: Record<string, unknown>;
          artifactId: string;
          artifactVersionId: string;
          evidenceId: null;
          changeSetId: null;
        }
      | {
          kind: "evidence";
          canonicalRef: string;
          contentHash: string;
          rawContent: string;
          metadata: Record<string, unknown>;
          artifactId: null;
          artifactVersionId: null;
          evidenceId: string;
          changeSetId: null;
        }
      | {
          kind: "changeset";
          canonicalRef: string;
          contentHash: string;
          rawContent: string;
          metadata: Record<string, unknown>;
          artifactId: null;
          artifactVersionId: null;
          evidenceId: null;
          changeSetId: string;
        };

    if (requestedRef.startsWith("ontology:")) {
      const hash = requestedRef
        .slice("ontology:".length)
        .replace(/^sha256:/, "");
      if (
        !SHA256.test(hash) ||
        input.session.ontologySnapshotHash?.replace(/^sha256:/, "") !== hash
      ) {
        throw new OntoCodeContextCompilerError(
          "ontocode_context_ref_invalid",
          "The Ontology context reference must match this Session's exact snapshot hash",
          409,
          { requestedRef },
        );
      }
      const digest = input.ontologyDigest?.trim();
      const rawContent = canonicalEvidenceJson({
        domain: input.project.domain,
        snapshotHash: hash,
        trust: "authoritative_session_snapshot",
        // 拿到摘要就给事实；没拿到就明说是「只有身份、没有内容」，让下游知道自己在瞎猜。
        ...(digest
          ? { digest }
          : {
              digestUnavailable:
                "本次未能载入该快照的结构化摘要，因此下面没有任何领域事实可用。",
            }),
      });
      resolved = {
        kind: "ontology",
        canonicalRef: `ontology:${hash}`,
        contentHash: hash,
        rawContent,
        metadata: {
          domain: input.project.domain,
          snapshotHash: hash,
          trust: "authoritative_session_snapshot",
          hasDigest: Boolean(digest),
        },
        artifactId: null,
        artifactVersionId: null,
        evidenceId: null,
        changeSetId: null,
      };
    } else if (
      requestedRef.startsWith("artifact:") ||
      requestedRef.startsWith("ontocode-artifact-version:")
    ) {
      const value = requestedRef.startsWith("artifact:")
        ? requestedRef.slice("artifact:".length)
        : requestedRef.slice("ontocode-artifact-version:".length);
      const separator = value.indexOf("@");
      const artifactIdHint = separator >= 0 ? value.slice(0, separator) : null;
      const versionId = separator >= 0 ? value.slice(separator + 1) : value;
      if (!versionId) {
        throw new OntoCodeContextCompilerError(
          "ontocode_context_ref_invalid",
          "Artifact context references require an exact Artifact Version id",
          400,
          { requestedRef },
        );
      }
      const artifact = artifactContext(
        input.ctx,
        input.session.id,
        requestedRef,
        artifactIdHint,
        versionId,
      );
      resolved = {
        kind: "artifact",
        canonicalRef: artifact.canonicalRef,
        contentHash: artifact.contentHash,
        rawContent: artifact.rawContent,
        metadata: artifact.metadata,
        artifactId: artifact.artifact.id,
        artifactVersionId: artifact.version.id,
        evidenceId: null,
        changeSetId: null,
      };
    } else if (requestedRef.startsWith("evidence:")) {
      const evidenceId = requestedRef.slice("evidence:".length);
      if (!evidenceId) {
        throw new OntoCodeContextCompilerError(
          "ontocode_context_ref_invalid",
          "Evidence context references require an exact Evidence id",
          400,
          { requestedRef },
        );
      }
      const evidence = evidenceContext(
        input.ctx,
        input.session.id,
        requestedRef,
        evidenceId,
      );
      resolved = {
        kind: "evidence",
        canonicalRef: evidence.canonicalRef,
        contentHash: evidence.contentHash,
        rawContent: evidence.rawContent,
        metadata: evidence.metadata,
        artifactId: null,
        artifactVersionId: null,
        evidenceId: evidence.evidence.id,
        changeSetId: null,
      };
    } else if (requestedRef.startsWith("changeset:")) {
      const changeSetId = requestedRef.slice("changeset:".length);
      if (!changeSetId) {
        throw new OntoCodeContextCompilerError(
          "ontocode_context_ref_invalid",
          "Change Set context references require an exact Change Set id",
          400,
          { requestedRef },
        );
      }
      const changeSet = changeSetContext(
        input.ctx,
        input.session.id,
        requestedRef,
        changeSetId,
      );
      resolved = {
        kind: "changeset",
        canonicalRef: changeSet.canonicalRef,
        contentHash: changeSet.contentHash,
        rawContent: changeSet.rawContent,
        metadata: changeSet.metadata,
        artifactId: null,
        artifactVersionId: null,
        evidenceId: null,
        changeSetId: changeSet.changeSet.id,
      };
    } else {
      throw new OntoCodeContextCompilerError(
        "ontocode_context_ref_invalid",
        "Context refs must be exact ontology:, artifact:, evidence:, or changeset: references",
        400,
        { requestedRef },
      );
    }

    const bounded = boundedContent(
      resolved.rawContent,
      resolved.canonicalRef,
      maxBytes - totalBytes,
      maxRefBytes,
    );
    if ("exceeded" in bounded) {
      const remainingBytes = Math.max(0, maxBytes - totalBytes);
      // 拒绝必须是可行动的。以前这里只给 { maxBytes, requestedRef }：FDE 被告知
      // 预算爆了，却不知道爆了多少、也不知道预算正被谁占着——除了重试一次一模一样
      // 的请求之外无事可做。现在把「差多少」和「丢掉谁能腾出多少」一并说清。
      const includedRefs = refs.map((ref) => ({
        canonicalRef: ref.canonicalRef,
        includedBytes: ref.includedBytes,
      }));
      throw new OntoCodeContextCompilerError(
        "ontocode_context_budget_exceeded",
        `The selected context references exceed the Assistant context budget: ` +
          `"${resolved.canonicalRef}" needs ${bounded.rawBytes} bytes and only ` +
          `${remainingBytes} of ${maxBytes} remain (${totalBytes} already used by ` +
          `${refs.length} earlier reference(s); per-reference cap ${maxRefBytes}). ` +
          `Drop an earlier reference or request this one on its own.`,
        413,
        {
          requestedRef,
          canonicalRef: resolved.canonicalRef,
          maxBytes,
          maxRefBytes,
          minRefBytes: envPositiveInt(MIN_REF_BYTES_ENV, DEFAULT_MIN_REF_BYTES),
          requiredBytes: bounded.rawBytes,
          consumedBytes: totalBytes,
          remainingBytes,
          includedRefs,
        },
      );
    }
    totalBytes += bounded.bytes;
    refs.push({
      kind: resolved.kind,
      requestedRef,
      canonicalRef: resolved.canonicalRef,
      contentHash: resolved.contentHash,
      content: bounded.content,
      truncated: bounded.truncated,
      redacted: bounded.redacted,
      rawBytes: bounded.rawBytes,
      includedBytes: bounded.bytes,
      droppedBytes: Math.max(0, bounded.rawBytes - bounded.bytes),
      truncationReason: bounded.reason,
      artifactId: resolved.artifactId,
      artifactVersionId: resolved.artifactVersionId,
      evidenceId: resolved.evidenceId,
      changeSetId: resolved.changeSetId,
      metadata: resolved.metadata,
    });
  }

  const manifest: OntoCodeCompiledContext["manifest"] = {
    schema: "ontocode-context-manifest/v1",
    totalBytes,
    maxBytes,
    maxRefBytes,
    // 只报活下来的字节数就是在粉饰：清单必须同时给出「本来有多少」和「丢了多少」，
    // 否则 `truncated: true` 是一个没有分母的断言。
    requestedBytes: refs.reduce((sum, ref) => sum + ref.rawBytes, 0),
    droppedBytes: refs.reduce((sum, ref) => sum + ref.droppedBytes, 0),
    truncatedRefs: refs.filter((ref) => ref.truncated).length,
    refs: refs.map((ref) => ({
      kind: ref.kind,
      requestedRef: ref.requestedRef,
      canonicalRef: ref.canonicalRef,
      contentHash: ref.contentHash,
      includedBytes: ref.includedBytes,
      rawBytes: ref.rawBytes,
      droppedBytes: ref.droppedBytes,
      truncationReason: ref.truncationReason,
      truncated: ref.truncated,
      redacted: ref.redacted,
    })),
  };
  const contextHash = sha256(
    canonicalEvidenceJson({
      sessionId: input.session.id,
      sessionRevision: input.session.revision,
      ontologySnapshotHash: input.session.ontologySnapshotHash,
      manifest,
      content: refs.map((ref) => ({
        canonicalRef: ref.canonicalRef,
        content: ref.content,
      })),
    }),
  );

  return {
    schema: "ontocode-compiled-context/v1",
    contextHash,
    sessionId: input.session.id,
    sessionRevision: input.session.revision,
    ontologySnapshotHash: input.session.ontologySnapshotHash,
    refs,
    manifest,
  };
}

/** Context lookup failures have already been translated at their exact load site. */
export function normalizeOntoCodeContextCompilerError(
  error: unknown,
): OntoCodeContextCompilerError | null {
  if (error instanceof OntoCodeContextCompilerError) return error;
  return null;
}
