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
const DEFAULT_MAX_CONTEXT_BYTES = 48_000;
const DEFAULT_MAX_REF_BYTES = 24_000;

export type OntoCodeCompiledContextRefKind =
  | "ontology"
  | "artifact"
  | "evidence"
  | "changeset";

export interface OntoCodeCompiledContextRef {
  kind: OntoCodeCompiledContextRefKind;
  requestedRef: string;
  canonicalRef: string;
  contentHash: string;
  content: string;
  truncated: boolean;
  redacted: boolean;
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
    refs: Array<{
      kind: OntoCodeCompiledContextRefKind;
      requestedRef: string;
      canonicalRef: string;
      contentHash: string;
      includedBytes: number;
      truncated: boolean;
      redacted: boolean;
    }>;
  };
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

function boundedContent(
  raw: string,
  remainingBytes: number,
  maxRefBytes: number,
): {
  content: string;
  bytes: number;
  truncated: boolean;
  redacted: boolean;
} {
  if (isSecretShapedString(raw)) {
    const content = "[REDACTED_SECRET_SHAPED_CONTEXT]";
    return {
      content,
      bytes: Buffer.byteLength(content, "utf8"),
      truncated: false,
      redacted: true,
    };
  }
  const allowed = Math.max(0, Math.min(remainingBytes, maxRefBytes));
  const rawBytes = Buffer.byteLength(raw, "utf8");
  if (rawBytes <= allowed) {
    return { content: raw, bytes: rawBytes, truncated: false, redacted: false };
  }
  if (allowed === 0) {
    return { content: "", bytes: 0, truncated: true, redacted: false };
  }
  const buffer = Buffer.from(raw, "utf8").subarray(0, allowed);
  // Dropping an incomplete trailing UTF-8 sequence through decode is safe and
  // keeps the model context inside the hard byte budget.
  const content = buffer.toString("utf8");
  return {
    content,
    bytes: Buffer.byteLength(content, "utf8"),
    truncated: true,
    redacted: false,
  };
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
  const result = getOntoCodeArtifactVersion(ctx, versionId);
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
  const evidence = getOntoCodeEvidenceRecord(ctx, evidenceId);
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
  const result = getOntoCodeChangeSet(ctx, changeSetId);
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
  const maxBytes = input.maxBytes ?? DEFAULT_MAX_CONTEXT_BYTES;
  const maxRefBytes = input.maxRefBytes ?? DEFAULT_MAX_REF_BYTES;
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
          : { digestUnavailable: "本次未能载入该快照的结构化摘要，因此下面没有任何领域事实可用。" }),
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
      maxBytes - totalBytes,
      maxRefBytes,
    );
    if (bounded.bytes === 0 && resolved.rawContent.length > 0) {
      throw new OntoCodeContextCompilerError(
        "ontocode_context_budget_exceeded",
        "The selected context references exceed the Assistant context budget",
        413,
        { maxBytes, requestedRef },
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
    refs: refs.map((ref) => ({
      kind: ref.kind,
      requestedRef: ref.requestedRef,
      canonicalRef: ref.canonicalRef,
      contentHash: ref.contentHash,
      includedBytes: Buffer.byteLength(ref.content, "utf8"),
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

/**
 * Translate tenant-scoped storage errors into the compiler's public error
 * boundary without disclosing whether a cross-tenant id exists.
 */
export function normalizeOntoCodeContextCompilerError(
  error: unknown,
): OntoCodeContextCompilerError | null {
  if (error instanceof OntoCodeContextCompilerError) return error;
  if (error instanceof OntoCodeStoreError) {
    return new OntoCodeContextCompilerError(
      "ontocode_context_ref_invalid",
      "One or more selected context references are unavailable in this Tenant and Session",
      error.statusCode === 404 ? 404 : error.statusCode,
    );
  }
  return null;
}
