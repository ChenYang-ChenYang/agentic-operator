// #FAILURE-RECEIPT (Q7) —— 失败的 Harness 作业也必须留下一份可核验的终态回执。
//
// 实测缺陷：`done` 与 `waiting_user` 两条终态路径都会写下不可变回执（readiness / interaction /
// 证据 / 产物），失败路径【什么都不写】——只有一行 `errorMessage` 和一条 `harness.job.failed`
// 事件里的 error code。于是 FDE 问「这次 Build 为什么失败」时，产品答不出来；而线上 OntoCode
// 的作业分布是 12 waiting_user / 10 cancelled / 6 failed_recoverable / 0 succeeded——失败
// 是【命中率最高】的那条路径。
//
// 本模块只做一件事：把失败当刻【已经被平台记录下来的事实】收拢成一份有界回执。三条纪律：
//
//  1) 不发明原因。回执里每一个字段都必须指得回一条真实记录：Job 行、Session 行、
//     `ontocode_session_events` 里这个作业自己的持久事件、以及 Factory 运行的 NDJSON 转录。
//     模型撰写的失败解释【不在】本回执内；`interpretation` 显式声明为 absent，将来若加入
//     必须像 Ontology 分析师那样标注「未作语义验证」。
//
//  2) 读不到就说读不到。转录缺失 / 不可读时，`evidence.status` 是 `absent` / `unreadable`
//     并带上查过的地址与失败原因——绝不省略该字段，也绝不用一个空结构冒充「这次很干净」。
//
//  3) 证据读路径不重写。转录的读取一律走大脑那份 `readRunEvidence`
//     （packages/agent-factory/src/run-evidence.ts）：有界流式扫描、密钥脱敏、载荷预算、
//     以及【租户隔离在地址里】——一次跨租户读在物理上就是一次 miss。本模块不碰文件系统。

import { and, desc, eq, inArray } from "drizzle-orm";
import { getDb, ontocodeSessionEvents } from "@agentic/db";
import {
  readRunEvidence,
  summarizeRunEvidence,
  windowEvidenceText,
  type RunEvidence,
  type RunEvidenceFrame,
} from "@agentic/agent-factory";
import type {
  OntoCodeHarnessJobKind,
  OntoCodeSessionPhase,
} from "@agentic/contracts";

export const ONTOCODE_FAILURE_RECEIPT_SCHEMA = "ontocode-failure-receipt/v1";

/**
 * 失败回执要同时进事件载荷、助手消息与不可变产物三处，所以证据面比大脑单次诊断读更紧。
 * 上限收紧【只能收紧】——runEvidenceLimits 自己会把非法值夹回合法区间。
 */
const FAILURE_EVIDENCE_LIMITS = {
  maxFailures: 6,
  leadUp: 4,
  frameChars: 400,
  maxPayloadChars: 8_000,
} as const;

/** 作业自己的持久事件尾巴：失败前最后发生的事，转录缺席时这是唯一还在的时间线。 */
const DURABLE_TAIL_LIMIT = 10;
const DURABLE_TAIL_EXCERPT_CHARS = 300;

/** 送进 Factory 目标的接地文本硬上限——一段诊断不该吃掉整个上下文窗口。 */
const GROUNDING_MAX_CHARS = 6_000;

export interface OntoCodeFailureReceiptError {
  code: string;
  message: string;
  recoverable: boolean;
  retryable: boolean;
  details?: Record<string, unknown>;
}

export interface BuildOntoCodeFailureReceiptInput {
  tenantId: string;
  sessionId: string;
  jobId: string;
  jobKind: OntoCodeHarnessJobKind;
  attempt: number;
  maxAttempts: number;
  status: "failed_recoverable" | "failed_terminal";
  /** 这个 Job 本来要推进到的阶段。由调用方（worker 的 phaseForJob）给出，本模块不复刻那张映射。 */
  targetPhase: OntoCodeSessionPhase;
  /** 失败当刻 Session 行上的真实 phase —— 一条 DB 事实，不是推断。 */
  sessionPhase: OntoCodeSessionPhase;
  ontologyHash: string | null;
  commandId: string | null;
  error: OntoCodeFailureReceiptError;
  finishedAt: number;
}

interface DurableEventTailEntry {
  seq: number;
  type: string;
  at: number;
  visibility: string;
  excerpt: string;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * 这次失败可能落在盘上的转录地址。
 *
 * 顺序即优先级：错误自己声明的 `factoryRunId`（续跑失败时它指向被续的那次运行，和本作业的
 * 地址不同）优先；其后是本作业【本次尝试往前回溯】的地址——第 3 次尝试可能还没碰到 Factory
 * 就炸了，而第 1 次尝试的转录仍然在，那份才是唯一解释得了这次失败的记录。
 *
 * runId 只是文件名；读哪个租户目录由已认证的 tenantId 决定（见 run-evidence 的纪律 1）。
 */
export function failureTranscriptRunIdCandidates(input: {
  jobId: string;
  attempt: number;
  details?: Record<string, unknown> | undefined;
  recordedFactoryRunIds?: readonly string[] | undefined;
}): string[] {
  const declared = nonEmptyString(input.details?.factoryRunId);
  const candidates = declared ? [declared] : [];
  for (const runId of input.recordedFactoryRunIds ?? []) {
    const recorded = nonEmptyString(runId);
    if (recorded) candidates.push(recorded);
  }
  for (let attempt = input.attempt; attempt >= 1; attempt -= 1) {
    candidates.push(`ocf-${input.jobId}-a${attempt}`);
  }
  return [...new Set(candidates)];
}

/** A resumed Build can keep the Factory run id of its parent waiting job, so
 * the current job's deterministic `ocf-<job>-a<n>` addresses are insufficient.
 * The Harness already recorded the exact run id at its Factory boundary; use
 * that durable provenance before falling back to inferred addresses. */
function readRecordedFactoryRunIds(
  tenantId: string,
  sessionId: string,
  jobId: string,
): string[] {
  const rows = getDb()
    .select({ payloadJson: ontocodeSessionEvents.payloadJson })
    .from(ontocodeSessionEvents)
    .where(
      and(
        eq(ontocodeSessionEvents.tenantId, tenantId),
        eq(ontocodeSessionEvents.sessionId, sessionId),
        eq(ontocodeSessionEvents.harnessJobId, jobId),
        inArray(ontocodeSessionEvents.type, [
          "harness.build.factory_started",
          "harness.build.factory_reconnected",
        ]),
      ),
    )
    .orderBy(desc(ontocodeSessionEvents.seq))
    .limit(20)
    .all();
  return rows.flatMap((row) => {
    try {
      const runId = nonEmptyString(
        asRecord(JSON.parse(row.payloadJson))?.factoryRunId,
      );
      return runId ? [runId] : [];
    } catch {
      return [];
    }
  });
}

interface FailureEvidenceSection {
  section: Record<string, unknown>;
  evidence: RunEvidence | null;
  runId: string | null;
}

/**
 * 按地址逐个探转录，第一份读到的即采用。
 *
 * 三种结果都必须【说出来】：读到（read）、租户目录下确实没有（absent）、读的过程本身出错
 * （unreadable，带原文）。绝不因为读不到就把 evidence 字段整个省掉——省掉等于让「未知」
 * 渲染成「没问题」。
 */
async function readFailureEvidence(
  tenantId: string,
  candidates: readonly string[],
): Promise<FailureEvidenceSection> {
  const readErrors: string[] = [];
  for (const runId of candidates) {
    let evidence: RunEvidence;
    try {
      evidence = await readRunEvidence({
        tenantId,
        runId,
        limits: { ...FAILURE_EVIDENCE_LIMITS },
      });
    } catch (error) {
      readErrors.push(
        `${runId}: ${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }
    if (!evidence.found) continue;
    return {
      runId,
      evidence,
      section: {
        source: "factory-run-transcript-ndjson",
        status: "read",
        runId,
        searchedRunIds: [...candidates],
        summary: summarizeRunEvidence(evidence),
        ...(evidence.frames === 0
          ? {
              note: "转录文件存在但没有任何可解析的帧；本次失败没有运行内证据可引用。",
            }
          : {}),
        digest: evidence,
      },
    };
  }
  if (readErrors.length > 0) {
    return {
      runId: null,
      evidence: null,
      section: {
        source: "factory-run-transcript-ndjson",
        status: "unreadable",
        searchedRunIds: [...candidates],
        reason: `本租户下的运行转录读取失败，本回执因此不包含运行内证据，也不推测原因：${readErrors.join("；")}`,
        readErrors,
      },
    };
  }
  return {
    runId: null,
    evidence: null,
    section: {
      source: "factory-run-transcript-ndjson",
      status: "absent",
      searchedRunIds: [...candidates],
      reason:
        candidates.length > 0
          ? `本租户下没有找到这次作业的运行转录（已按地址查过：${candidates.join("、")}）；本回执因此不包含运行内证据，也不推测原因。`
          : "没有可推导的运行转录地址；本回执因此不包含运行内证据，也不推测原因。",
    },
  };
}

/**
 * 这个作业自己的持久事件尾巴（`ontocode_session_events`，按 seq 倒序取最近若干条后翻正）。
 * 它跟转录是两个独立来源：Harness 遥测桥接把工具调用/结果/错误写在这里，即使 Factory
 * 从来没起来（转录不存在）也仍然有一条真实时间线。
 */
function readDurableEventTail(
  tenantId: string,
  sessionId: string,
  jobId: string,
): DurableEventTailEntry[] {
  const rows = getDb()
    .select({
      seq: ontocodeSessionEvents.seq,
      type: ontocodeSessionEvents.type,
      visibility: ontocodeSessionEvents.visibility,
      payloadJson: ontocodeSessionEvents.payloadJson,
      createdAt: ontocodeSessionEvents.createdAt,
    })
    .from(ontocodeSessionEvents)
    .where(
      and(
        eq(ontocodeSessionEvents.tenantId, tenantId),
        eq(ontocodeSessionEvents.sessionId, sessionId),
        eq(ontocodeSessionEvents.harnessJobId, jobId),
      ),
    )
    .orderBy(desc(ontocodeSessionEvents.seq))
    .limit(DURABLE_TAIL_LIMIT)
    .all();
  return rows
    .map((row) => ({
      seq: row.seq,
      type: row.type,
      at: row.createdAt.getTime(),
      visibility: row.visibility,
      excerpt: windowEvidenceText(row.payloadJson, DURABLE_TAIL_EXCERPT_CHARS),
    }))
    .reverse();
}

/** 转录里最后一次声明的流水线阶段。没有就是没有——不拿 targetPhase 冒充「跑到了哪」。 */
function factoryStageFromEvidence(evidence: RunEvidence | null): string | null {
  if (!evidence) return null;
  const frames: RunEvidenceFrame[] = [
    ...(evidence.terminal ? [evidence.terminal] : []),
    ...[...evidence.leadUp].reverse(),
    ...[...evidence.failures].reverse(),
  ];
  for (const frame of frames) {
    if (frame.stage) return frame.stage;
  }
  return null;
}

/**
 * 组装一份失败终态回执。永不抛出：这条路径是作业的最后一程，一次诊断读的失败不能把
 * 「作业失败」本身也一起弄丢。任何一处收集不到，回执里都留一句显式的「收集不到」。
 */
export async function buildOntoCodeFailureReceipt(
  input: BuildOntoCodeFailureReceiptInput,
): Promise<Record<string, unknown>> {
  let recordedFactoryRunIds: string[] = [];
  try {
    recordedFactoryRunIds = readRecordedFactoryRunIds(
      input.tenantId,
      input.sessionId,
      input.jobId,
    );
  } catch {
    // Failure receipts are terminal diagnostics. A provenance lookup failure
    // must degrade to deterministic addresses, never hide the job failure.
  }
  const candidates = failureTranscriptRunIdCandidates({
    jobId: input.jobId,
    attempt: input.attempt,
    details: input.error.details,
    recordedFactoryRunIds,
  });

  let evidenceSection: FailureEvidenceSection;
  try {
    evidenceSection = await readFailureEvidence(input.tenantId, candidates);
  } catch (error) {
    evidenceSection = {
      runId: null,
      evidence: null,
      section: {
        source: "factory-run-transcript-ndjson",
        status: "unreadable",
        searchedRunIds: [...candidates],
        reason: `运行转录证据收集本身出错，本回执不含运行内证据：${
          error instanceof Error ? error.message : String(error)
        }`,
      },
    };
  }

  let tail: DurableEventTailEntry[] = [];
  let tailSection: Record<string, unknown>;
  try {
    tail = readDurableEventTail(input.tenantId, input.sessionId, input.jobId);
    tailSection =
      tail.length > 0
        ? {
            source: "ontocode_session_events",
            status: "read",
            limit: DURABLE_TAIL_LIMIT,
            count: tail.length,
            entries: tail,
          }
        : {
            source: "ontocode_session_events",
            status: "empty",
            limit: DURABLE_TAIL_LIMIT,
            count: 0,
            reason:
              "这个作业在失败前没有留下任何持久事件；平台没有可引用的作业内时间线。",
            entries: [],
          };
  } catch (error) {
    tailSection = {
      source: "ontocode_session_events",
      status: "unreadable",
      limit: DURABLE_TAIL_LIMIT,
      count: 0,
      reason: `作业持久事件读取失败，本回执不含作业内时间线：${
        error instanceof Error ? error.message : String(error)
      }`,
      entries: [],
    };
  }

  const factoryStage = factoryStageFromEvidence(evidenceSection.evidence);
  return {
    schema: ONTOCODE_FAILURE_RECEIPT_SCHEMA,
    operation: input.jobKind,
    outcome: "failed",
    status: input.status,
    jobId: input.jobId,
    sessionId: input.sessionId,
    attempt: input.attempt,
    maxAttempts: input.maxAttempts,
    finishedAt: input.finishedAt,
    commandId: input.commandId,
    ontologyHash: input.ontologyHash,
    error: {
      code: input.error.code,
      message: input.error.message,
      recoverable: input.error.recoverable,
      retryable: input.error.retryable,
      ...(input.error.details ? { details: input.error.details } : {}),
    },
    reached: {
      targetPhase: input.targetPhase,
      sessionPhase: input.sessionPhase,
      factoryStage,
      factoryStageSource: factoryStage
        ? "factory-run-transcript"
        : "unavailable",
      lastDurableEventType: tail.length > 0 ? tail[tail.length - 1]!.type : null,
    },
    evidence: evidenceSection.section,
    durableEvents: tailSection,
    // 模型撰写的原因判断【不在】本回执内。将来若加入，必须像 Ontology 分析师那样把它标注为
    // 「未作语义验证」，而不是让它和上面这些已记录事实混在同一层。
    interpretation: {
      status: "absent",
      note: "本回执只记录平台已记录的事实（作业行、会话行、作业持久事件、运行转录）；不含模型撰写的失败原因。",
    },
    provenance: [
      `ontocode_harness_jobs:${input.jobId}`,
      `ontocode_session_events:${input.sessionId}`,
      ...(evidenceSection.runId
        ? [`factory-run-transcript:${evidenceSection.runId}`]
        : []),
    ],
  };
}

/**
 * 一行人话的失败概要——助手消息正文用。
 *
 * 刻意【不】复用 summarizeRunEvidence：那一行以 `运行 ocf-ocj-…-a1：` 开头，裸存储 id 属于
 * 投影层词汇白名单明令禁止进入用户可见文本的那一类（apps/web/.../projection.ts 的
 * FORBIDDEN_VOCABULARY）。精确到 id 的口径留在回执结构里，聊天正文只说人话。
 */
export function summarizeOntoCodeFailureReceipt(
  receipt: Record<string, unknown>,
): string | null {
  if (receipt.schema !== ONTOCODE_FAILURE_RECEIPT_SCHEMA) return null;
  const error = asRecord(receipt.error);
  const evidence = asRecord(receipt.evidence);
  const reached = asRecord(receipt.reached);
  const code = nonEmptyString(error?.code) ?? "unknown_error";
  const stage = nonEmptyString(reached?.factoryStage);
  let evidenceNote: string;
  if (evidence?.status === "read") {
    const digest = asRecord(evidence.digest);
    const failureCount =
      typeof digest?.failureCount === "number" ? digest.failureCount : 0;
    evidenceNote =
      failureCount > 0
        ? `已从本次运行的过程记录里取到 ${failureCount} 条失败证据原文${stage ? `，最后停在「${stage}」环节` : ""}`
        : `本次运行的过程记录已读到，但其中没有任何一帧命中失败判据${stage ? `，最后停在「${stage}」环节` : ""}`;
  } else if (evidence?.status === "unreadable") {
    evidenceNote =
      "本次运行的过程记录读取失败，因此给不出更细的原因（不做推测）";
  } else {
    evidenceNote =
      "平台没有找到本次运行的过程记录，因此给不出更细的原因（不做推测）";
  }
  return `终态错误 ${code} · ${evidenceNote}。完整回执已保存，可在产物与证据里逐帧核对。`;
}

/**
 * 一帧证据渲染成一行可引用的文本。
 *
 * 刻意对形状宽容：本函数会被用在【从库里读回来的】回执上（可能是更早版本写下的、或者过了
 * 脱敏边界之后的），而它的调用方是 `debug_failure` 的接地路径——在那里抛一个 TypeError 等于
 * 把一次本可以继续的调试变成一次新的失败。缺字段就少一段，绝不炸。
 */
function frameLine(frame: Record<string, unknown>): string {
  const signalList = Array.isArray(frame.signals)
    ? frame.signals.filter((item): item is string => typeof item === "string")
    : [];
  const signals = signalList.length ? `（${signalList.join("、")}）` : "";
  const toolName = nonEmptyString(frame.tool);
  const stageName = nonEmptyString(frame.stage);
  const position =
    typeof frame.byteOffset === "number"
      ? `（字节偏移 ${frame.byteOffset}）`
      : "";
  const redacted =
    typeof frame.redacted === "number"
      ? `（原文已脱敏 ${frame.redacted} 处）`
      : "";
  return `- 帧 #${String(frame.index ?? "?")}${position}${nonEmptyString(frame.t) ?? "(未知帧)"}${toolName ? `/${toolName}` : ""}${signals}${stageName ? ` 阶段=${stageName}` : ""}${redacted} ｜ ${nonEmptyString(frame.excerpt) ?? ""}`;
}

/**
 * 把一份持久失败回执渲染成【接地文本】：`debug_failure` 用它代替「请 FDE 手写一段失败摘要」。
 *
 * 输出的每一行都指得回一条真实记录（终态错误原文、带字节偏移的失败帧、作业持久事件序号），
 * 并在开头就声明这是平台记录、未经模型解释。回执不是失败回执时返回 null——调用方据此
 * 如实拒绝，而不是拿一份别的东西凑数。
 */
export function renderFailureReceiptGrounding(
  receipt: Record<string, unknown>,
): string | null {
  if (receipt.schema !== ONTOCODE_FAILURE_RECEIPT_SCHEMA) return null;
  const error = asRecord(receipt.error);
  if (!error) return null;
  const evidence = asRecord(receipt.evidence);
  const reached = asRecord(receipt.reached);
  const durable = asRecord(receipt.durableEvents);
  const lines: string[] = [
    "[持久失败证据 · 取自平台已记录的事实，未经模型解释]",
    `作业 ${nonEmptyString(receipt.jobId) ?? "(未知)"}（${nonEmptyString(receipt.operation) ?? "unknown"}）第 ${String(receipt.attempt ?? "?")}/${String(receipt.maxAttempts ?? "?")} 次尝试，终态 ${nonEmptyString(receipt.status) ?? "failed"}。`,
    `终态错误 code=${nonEmptyString(error.code) ?? "unknown_error"}`,
    `终态错误 message=${windowEvidenceText(nonEmptyString(error.message) ?? "(空)", 800)}`,
  ];
  if (reached) {
    lines.push(
      `跑到哪：会话阶段=${nonEmptyString(reached.sessionPhase) ?? "未知"} · 目标阶段=${nonEmptyString(reached.targetPhase) ?? "未知"} · 运行阶段=${nonEmptyString(reached.factoryStage) ?? "转录未声明（不推断）"} · 最后一条平台事件=${nonEmptyString(reached.lastDurableEventType) ?? "无"}`,
    );
  }

  if (evidence?.status === "read") {
    lines.push(
      `运行证据：${nonEmptyString(evidence.summary) ?? "已读取运行转录"}`,
    );
    const digest = asRecord(evidence.digest);
    const failures = Array.isArray(digest?.failures)
      ? digest.failures
          .map((frame) => asRecord(frame))
          .filter((frame): frame is Record<string, unknown> => frame !== null)
      : [];
    if (failures.length > 0) {
      lines.push("失败帧原文：");
      for (const frame of failures) lines.push(frameLine(frame));
    }
    const terminal = asRecord(digest?.terminal);
    if (terminal) lines.push(`终态帧：${frameLine(terminal).slice(2)}`);
    const truncation = Array.isArray(digest?.truncation)
      ? (digest.truncation as unknown[]).filter(
          (item): item is string => typeof item === "string",
        )
      : [];
    for (const note of truncation) lines.push(`⚠ 有界截断：${note}`);
  } else {
    lines.push(
      `运行证据：${nonEmptyString(evidence?.reason) ?? "读不到本次运行的持久转录"}`,
    );
  }

  const entries = Array.isArray(durable?.entries) ? durable.entries : [];
  if (entries.length > 0) {
    lines.push("失败前这个作业的持久事件（旧→新）：");
    for (const raw of entries) {
      const entry = asRecord(raw);
      if (!entry) continue;
      lines.push(
        `- #${String(entry.seq ?? "?")} ${nonEmptyString(entry.type) ?? "(未知类型)"} ｜ ${nonEmptyString(entry.excerpt) ?? ""}`,
      );
    }
  } else if (durable) {
    lines.push(
      `失败前这个作业的持久事件：${nonEmptyString(durable.reason) ?? "无"}`,
    );
  }

  return windowEvidenceText(lines.join("\n"), GROUNDING_MAX_CHARS);
}
