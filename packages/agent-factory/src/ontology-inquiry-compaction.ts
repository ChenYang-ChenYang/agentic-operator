// #INQUIRY-COMPACT — context compaction for the read-only ontology analysis loop.
//
// The inquiry loop's `messages` array is append-only. Before this module it hit
// ONTOLOGY_INQUIRY_TOTAL_RESULT_CHARS and BROKE OUT: a deep analysis that read a
// lot of a real domain simply stopped early with a partial answer. That is the
// wrong trade — the loop should compact and CONTINUE.
//
// The discipline is the conductor's (conductor.ts `maybeCompact`), applied to a
// surface that has no BrainCtx, and it is deliberately STRICTER in one place:
//
//   · ARCHIVE BEFORE FOLD, FAIL CLOSED. Nothing leaves the live context until a
//     lossless copy is durably written. The conductor keeps a legacy branch that
//     folds without retention when NO archive port is configured; this is a new
//     code path with no legacy to preserve, so "no archive" and "archive threw"
//     are the SAME answer here: do not fold. The loop then degrades exactly as it
//     did before this module existed, and says why.
//   · The fold is DETERMINISTIC. The conductor's tier-2 abstractive pass spends a
//     model call to preserve reasoning nuance across dropped prose turns; what
//     this loop drops is overwhelmingly serialized READS of the ontology, whose
//     faithful summary is "which reads happened, by name". Spending model calls
//     to summarize would come out of the very allowance the analysis is starving
//     for (the measured binding constraint on this surface is model calls, not
//     bytes), and an LLM paraphrase of evidence is exactly the kind of unciteable
//     claim this surface exists to avoid. So: real names, zero model calls.
//   · Every number reported here is a real pre-cap count. No silent truncation.
//
// The archive port is CONVERSATION-BOUND (`OntologyInquiryArchive`): unlike the
// factory's `FactoryConversationArchive`, no method takes a conversation id, so
// the loop — and therefore the model — has no way to address another
// conversation. Scoping is structural, fixed by the host at construction.

import {
  archiveEntriesFromDropped,
  archiveTruncationReport,
  type ConversationArchiveEntry,
  type ConversationArchiveSearchHit,
  type FactoryConversationArchive,
} from "./conversation-archive";
import {
  estimateMessageChars,
  recentContextStart,
  shouldCompactContext,
  type CompactionThresholds,
} from "./context-budget";
import type { ChatMsg } from "./stream-gateway";

// ── knobs (named constant + env override for every bound) ────────────────────

/** Fold when the live context crosses ANY of these, mirroring the conductor's
 * trigger so one surface does not quietly run a different policy. */
export const ONTOLOGY_INQUIRY_COMPACT_AT_MSGS_ENV =
  "ONTOLOGY_INQUIRY_COMPACT_AT_MSGS";
export const ONTOLOGY_INQUIRY_COMPACT_AT_MSGS_DEFAULT = 40;
export const ONTOLOGY_INQUIRY_COMPACT_AT_CHARS_ENV =
  "ONTOLOGY_INQUIRY_COMPACT_AT_CHARS";
export const ONTOLOGY_INQUIRY_COMPACT_AT_CHARS_DEFAULT = 240_000;
export const ONTOLOGY_INQUIRY_COMPACT_AT_ESTIMATED_TOKENS_ENV =
  "ONTOLOGY_INQUIRY_COMPACT_AT_ESTIMATED_TOKENS";
export const ONTOLOGY_INQUIRY_COMPACT_AT_ESTIMATED_TOKENS_DEFAULT = 60_000;

/** …and keep this much of the most recent contiguous run verbatim. Each keep
 * bound is forced strictly BELOW its trigger so a count-driven fold can never
 * grow the array. */
export const ONTOLOGY_INQUIRY_KEEP_RECENT_MSGS_ENV =
  "ONTOLOGY_INQUIRY_KEEP_RECENT_MSGS";
export const ONTOLOGY_INQUIRY_KEEP_RECENT_MSGS_DEFAULT = 12;
export const ONTOLOGY_INQUIRY_KEEP_RECENT_CHARS_ENV =
  "ONTOLOGY_INQUIRY_KEEP_RECENT_CHARS";
export const ONTOLOGY_INQUIRY_KEEP_RECENT_CHARS_DEFAULT = 80_000;
export const ONTOLOGY_INQUIRY_KEEP_RECENT_ESTIMATED_TOKENS_ENV =
  "ONTOLOGY_INQUIRY_KEEP_RECENT_ESTIMATED_TOKENS";
export const ONTOLOGY_INQUIRY_KEEP_RECENT_ESTIMATED_TOKENS_DEFAULT = 20_000;

/** Hard ceiling on how many times ONE analysis may fold. The loop is already
 * bounded by its model/tool-call budgets, so this is a belt-and-braces bound
 * against a pathological fold-per-turn cycle — and when it bites, it is
 * reported rather than being an invisible ceiling. */
export const ONTOLOGY_INQUIRY_MAX_FOLDS_ENV = "ONTOLOGY_INQUIRY_MAX_FOLDS";
export const ONTOLOGY_INQUIRY_MAX_FOLDS_DEFAULT = 12;

/** How many folded-out READ labels the model-visible notice lists. The list is
 * the anti-hallucination payload (real names, never counts), so it is generous;
 * when it does not fit, the real total is stated. */
export const ONTOLOGY_INQUIRY_FOLD_READ_LIST_CAP_ENV =
  "ONTOLOGY_INQUIRY_FOLD_READ_LIST_CAP";
export const ONTOLOGY_INQUIRY_FOLD_READ_LIST_CAP_DEFAULT = 60;
/** Bound on ONE rendered read label (`tool(argument)`). */
export const ONTOLOGY_INQUIRY_FOLD_READ_LABEL_CHARS_ENV =
  "ONTOLOGY_INQUIRY_FOLD_READ_LABEL_CHARS";
export const ONTOLOGY_INQUIRY_FOLD_READ_LABEL_CHARS_DEFAULT = 80;
/** Bound on a failure message quoted into the durable refusal record. */
export const ONTOLOGY_INQUIRY_FOLD_DETAIL_CHARS_ENV =
  "ONTOLOGY_INQUIRY_FOLD_DETAIL_CHARS";
export const ONTOLOGY_INQUIRY_FOLD_DETAIL_CHARS_DEFAULT = 300;

/**
 * Bound on ONE archived entry ON THIS SURFACE.
 *
 * The archive's own default (FACTORY_ARCHIVE_CONTENT_CAP, 64_000) is the
 * conductor's, sized against the conductor's largest single message. This loop
 * admits a `read_action` result up to
 * ONTOLOGY_INQUIRY_UNCLIPPED_RESULT_CHARS_DEFAULT (200_000) — under a 64,000
 * cap the fold would silently destroy ~136,000 chars of an already-read
 * contract and still report "已逐字归档". "Lossless before fold" is the whole
 * reason this module refuses to fold without an archive, so the cap is sized to
 * what the surface can actually admit: 256 KiB covers the largest admissible
 * tool result plus its JSON envelope and any `[tool_calls]` suffix, with slack.
 *
 * It is still a BOUND, not "unbounded" — and when an entry does not fit, the
 * fold is REFUSED (`archive_lossy`) rather than performed lossily. Storage is
 * NDJSON on disk, so the cost of the larger cap is disk, which is not the
 * binding constraint here; the cost of the smaller one was destroyed evidence.
 */
export const ONTOLOGY_INQUIRY_ARCHIVE_CONTENT_CAP_ENV =
  "ONTOLOGY_INQUIRY_ARCHIVE_CONTENT_CAP";
export const ONTOLOGY_INQUIRY_ARCHIVE_CONTENT_CAP_DEFAULT = 262_144;

function envInt(
  name: string,
  fallback: number,
  env: Record<string, string | undefined>,
): number {
  const raw = Number(env[name]);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
}

function clip(value: string, max: number): string {
  const text = value.trim();
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}

export interface OntologyInquiryCompactionConfig {
  trigger: CompactionThresholds;
  keep: CompactionThresholds;
  maxFolds: number;
  readListCap: number;
  readLabelCap: number;
  detailCap: number;
  /** Per-entry archive bound for THIS surface (see the constant's note). */
  archiveContentCap: number;
}

export function ontologyInquiryCompactionConfig(
  env: Record<string, string | undefined> = process.env,
): OntologyInquiryCompactionConfig {
  const maxMessages = envInt(
    ONTOLOGY_INQUIRY_COMPACT_AT_MSGS_ENV,
    ONTOLOGY_INQUIRY_COMPACT_AT_MSGS_DEFAULT,
    env,
  );
  const maxChars = envInt(
    ONTOLOGY_INQUIRY_COMPACT_AT_CHARS_ENV,
    ONTOLOGY_INQUIRY_COMPACT_AT_CHARS_DEFAULT,
    env,
  );
  const maxEstimatedTokens = envInt(
    ONTOLOGY_INQUIRY_COMPACT_AT_ESTIMATED_TOKENS_ENV,
    ONTOLOGY_INQUIRY_COMPACT_AT_ESTIMATED_TOKENS_DEFAULT,
    env,
  );
  return {
    trigger: { maxMessages, maxChars, maxEstimatedTokens },
    keep: {
      maxMessages: Math.min(
        envInt(
          ONTOLOGY_INQUIRY_KEEP_RECENT_MSGS_ENV,
          ONTOLOGY_INQUIRY_KEEP_RECENT_MSGS_DEFAULT,
          env,
        ),
        Math.max(1, maxMessages - 1),
      ),
      maxChars: Math.min(
        envInt(
          ONTOLOGY_INQUIRY_KEEP_RECENT_CHARS_ENV,
          ONTOLOGY_INQUIRY_KEEP_RECENT_CHARS_DEFAULT,
          env,
        ),
        Math.max(1, maxChars - 1),
      ),
      maxEstimatedTokens: Math.min(
        envInt(
          ONTOLOGY_INQUIRY_KEEP_RECENT_ESTIMATED_TOKENS_ENV,
          ONTOLOGY_INQUIRY_KEEP_RECENT_ESTIMATED_TOKENS_DEFAULT,
          env,
        ),
        Math.max(1, maxEstimatedTokens - 1),
      ),
    },
    maxFolds: envInt(
      ONTOLOGY_INQUIRY_MAX_FOLDS_ENV,
      ONTOLOGY_INQUIRY_MAX_FOLDS_DEFAULT,
      env,
    ),
    readListCap: envInt(
      ONTOLOGY_INQUIRY_FOLD_READ_LIST_CAP_ENV,
      ONTOLOGY_INQUIRY_FOLD_READ_LIST_CAP_DEFAULT,
      env,
    ),
    readLabelCap: envInt(
      ONTOLOGY_INQUIRY_FOLD_READ_LABEL_CHARS_ENV,
      ONTOLOGY_INQUIRY_FOLD_READ_LABEL_CHARS_DEFAULT,
      env,
    ),
    detailCap: envInt(
      ONTOLOGY_INQUIRY_FOLD_DETAIL_CHARS_ENV,
      ONTOLOGY_INQUIRY_FOLD_DETAIL_CHARS_DEFAULT,
      env,
    ),
    archiveContentCap: envInt(
      ONTOLOGY_INQUIRY_ARCHIVE_CONTENT_CAP_ENV,
      ONTOLOGY_INQUIRY_ARCHIVE_CONTENT_CAP_DEFAULT,
      env,
    ),
  };
}

// ── the conversation-bound archive port ──────────────────────────────────────

/**
 * The inquiry's view of the durable archive.
 *
 * Deliberately NOT `FactoryConversationArchive`: every method there takes a
 * `conversationId`, which makes "read someone else's conversation" a matter of
 * passing a different string. Here the id is bound by the HOST at construction
 * and appears nowhere the loop — or a model-authored tool argument — can reach.
 */
export interface OntologyInquiryArchive {
  append(entries: ConversationArchiveEntry[]): Promise<void>;
  search(
    query: string,
    opts?: { limit?: number },
  ): Promise<ConversationArchiveSearchHit[]>;
  count(): Promise<number>;
}

/** Bind a factory conversation archive to ONE conversation. The id is captured
 * in the closure; the returned port cannot address any other. */
export function bindOntologyInquiryArchive(
  store: FactoryConversationArchive,
  conversationId: string,
): OntologyInquiryArchive {
  const id = conversationId;
  return {
    append: (entries) => store.append(id, entries),
    search: (query, opts) => store.search(id, query, opts),
    count: () => store.count(id),
  };
}

// ── model-visible text (static; scanned by the #NO-TENANT-VOCAB gate) ────────

export const ONTOLOGY_INQUIRY_FOLD_TEMPLATE = {
  contextHeader:
    "【上下文已折叠：以下是被移出对话的早期内容的结构化清单，不是全部原文】",
  foldLine:
    "第 {seq} 次折叠：移出 {messages} 条消息、共 {chars} 字符（其中工具结果 {resultChars} 字符），已逐字归档 {archived} 条。",
  readsHeader: "被移出的工具调用（真实发生过的调用，逐字列出）：",
  readsLine: "· {reads}",
  readsTruncated: "（本次共 {total} 次调用，上面只列出 {shown} 次）",
  readsEmpty: "（本次折叠的内容里没有工具调用）",
  lossyLine:
    "注意：归档时有 {truncated}/{total} 条超过 {cap} 字符被截断，这部分原文已不可完整恢复。",
  recallLine:
    "被移出的原文已逐字归档。需要引用早期读取的细节时，用 {tool} 以空格分隔的关键词找回原文；不要凭印象补写被折叠掉的内容，也不要因为某个东西不在当前上下文里就断言它不存在。",
  continuityLine:
    "这是同一次分析的上下文压缩，不是重新开始：已经用 write_section 写出的段落依然有效，请接着往下分析，不要从头重读一遍。",
  /** Stable marker for the shipped answer's caveat — used to detect whether a
   * deliberated rewrite dropped it, so it can be re-asserted. */
  noticeMark: "本次分析是在被压缩过的上下文上完成的",
  noticeBody:
    "> ⚠ {mark}：过程中发生了 {folds} 次上下文折叠，共 {messages} 条早期消息、{chars} 字符（含 {reads} 次工具调用）被移出推理上下文。原文已逐字归档、可按关键词找回，但被折叠的内容没有参与其后的推理，因此本文不构成对该域的完整分析。",
  refusedMark: "本次分析没有做上下文压缩",
  refusedBody:
    "> ⚠ {mark}：上下文达到上限时无法为要移出的原文写入无损归档（{detail}），因此拒绝折叠——宁可在这里停下，也不静默丢弃已经读过的内容。以下是在预算耗尽处停下的部分分析。",
  /** Said in the deliberation record's own voice. */
  deliberationLine:
    "本次分析的上下文经历了 {folds} 次折叠、移出 {messages} 条早期消息，审议是在压缩后的上下文与已收集证据上进行的。",
} as const;

// ── what was folded out, by NAME ─────────────────────────────────────────────

/**
 * Real tool-call labels from the dropped span, in call order, deduplicated.
 *
 * The conductor's state summary emits real action/event/object NAMES rather than
 * counts, precisely so the model cannot hallucinate what it "must have" read.
 * Same rule here: `read_action(secondAction)` is checkable; "read 9 things" is
 * an invitation to invent the nine.
 */
export function describeFoldedToolCalls(
  dropped: readonly ChatMsg[],
  labelCap: number,
): { labels: string[]; total: number } {
  const labels: string[] = [];
  let total = 0;
  for (const message of dropped) {
    const calls = (message as { tool_calls?: unknown }).tool_calls;
    if (!Array.isArray(calls)) continue;
    for (const raw of calls) {
      const call = raw as {
        function?: { name?: unknown; arguments?: unknown };
      };
      const name =
        typeof call.function?.name === "string" ? call.function.name : null;
      if (!name) continue;
      total += 1;
      let subject: string | null = null;
      if (typeof call.function?.arguments === "string") {
        try {
          const parsed = JSON.parse(call.function.arguments) as unknown;
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            for (const [key, value] of Object.entries(
              parsed as Record<string, unknown>,
            )) {
              // `reasoning` is prose the model wrote about itself, not the
              // subject it read — labelling with it would name nothing.
              if (key === "reasoning") continue;
              if (typeof value === "string" && value.trim()) {
                subject = value.trim();
                break;
              }
              if (typeof value === "number" || typeof value === "boolean") {
                subject = String(value);
                break;
              }
            }
          }
        } catch {
          /* a malformed args string still yields a real tool NAME */
        }
      }
      const label = clip(subject ? `${name}(${subject})` : name, labelCap);
      if (!labels.includes(label)) labels.push(label);
    }
  }
  return { labels, total };
}

// ── the fold ─────────────────────────────────────────────────────────────────

/** One completed fold. Every field is a real pre-cap count. */
export interface OntologyInquiryFoldRecord {
  seq: number;
  at: number;
  /** Which ceiling asked for this fold. */
  trigger: "result_chars" | "context_size";
  droppedMessages: number;
  droppedChars: number;
  /** …of which this many chars were serialized TOOL RESULTS. The loop's own
   * cumulative result-char accounting is corrected by exactly this number, so
   * the ceiling tracks what is still in context rather than what was ever read. */
  droppedToolResultChars: number;
  keptMessages: number;
  archivedEntries: number;
  /** Always 0 on this surface: an entry that would be truncated REFUSES the
   * fold (`archive_lossy`) instead of being archived lossily. Kept as a real
   * measured count rather than dropped, so the record cannot start quietly
   * lying if that rule is ever relaxed. */
  archiveTruncatedEntries: number;
  archiveContentCap: number;
  /** Real tool-call labels from this fold's dropped span (bounded). */
  reads: string[];
  /** …of how many calls actually occurred in it. */
  readsTotal: number;
}

export type OntologyInquiryFoldRefusalReason =
  | "no_archive"
  | "archive_failed"
  /** An entry does not fit the per-entry archive bound, so archiving it would
   *  be LOSSY. Folding anyway would destroy already-read evidence while
   *  reporting a successful archive, so the fold does not happen. */
  | "archive_lossy"
  | "no_dropped_span"
  | "fold_limit";

export type OntologyInquiryFoldOutcome =
  | { folded: true; record: OntologyInquiryFoldRecord }
  | {
      folded: false;
      reason: OntologyInquiryFoldRefusalReason;
      detail: string;
    };

export interface OntologyInquiryFoldInput {
  /** Mutated IN PLACE on a successful fold, exactly like the conductor's. */
  messages: ChatMsg[];
  /** `messages[0, preservedPrefix)` is never folded. For this loop that is the
   * system prompt AND the seed (which carries the question and the id
   * inventory) — losing either would change what is being analysed. */
  preservedPrefix: number;
  /** Index of the assistant message that opened the CURRENT model turn. Nothing
   * at or after it may be dropped, so a fold triggered mid-turn can never split
   * an assistant tool_call from the tool results still being appended for it. */
  currentTurnStart: number;
  archive: OntologyInquiryArchive | undefined;
  /** All folds so far. Appended to on success; the notice is rebuilt from the
   * WHOLE ledger, so fold 1's read names survive fold 2. */
  ledger: OntologyInquiryFoldRecord[];
  trigger: "result_chars" | "context_size";
  now?: number;
  env?: Record<string, string | undefined>;
}

/** Should a fold be ATTEMPTED on size grounds alone? (The loop also attempts one
 * when its own cumulative result-char ceiling is crossed.) */
export function shouldFoldOntologyInquiryContext(
  messages: readonly ChatMsg[],
  env: Record<string, string | undefined> = process.env,
): boolean {
  return shouldCompactContext(
    messages as ChatMsg[],
    ontologyInquiryCompactionConfig(env).trigger,
  );
}

/**
 * Fold the oldest span out of the live context, verbatim-archived first.
 *
 * Returns `{folded:false}` — WITHOUT touching `messages` — whenever a lossless
 * copy cannot be written. The caller then degrades exactly as it did before
 * compaction existed. There is no branch in which content leaves the context
 * without having been archived.
 */
export async function foldOntologyInquiryContext(
  input: OntologyInquiryFoldInput,
): Promise<OntologyInquiryFoldOutcome> {
  const env = input.env ?? process.env;
  const config = ontologyInquiryCompactionConfig(env);
  const { messages } = input;

  const prefixEnd = Math.max(1, Math.min(input.preservedPrefix, messages.length));
  // A previous fold's notice sits directly after the preserved prefix. It is
  // SYNTHETIC — never archived (it is not original conversation) and simply
  // rebuilt from the whole ledger below.
  const dropStart = prefixEnd + (input.ledger.length > 0 ? 1 : 0);
  const turnFloor = Math.max(dropStart, input.currentTurnStart);
  const recentStart = Math.min(
    Math.max(recentContextStart(messages, config.keep), dropStart),
    turnFloor,
  );

  const prefix = messages.slice(0, prefixEnd);
  const dropped = messages.slice(dropStart, recentStart);
  const recent = messages.slice(recentStart);
  // Never split a tool_call/tool_result pair: an orphan result at the head of
  // the kept suffix folds together with the call that produced it.
  while (recent.length > 0 && recent[0]!.role === "tool") {
    dropped.push(recent.shift()!);
  }

  if (dropped.length === 0) {
    return {
      folded: false,
      reason: "no_dropped_span",
      detail:
        "当前上下文里没有可以安全移出的早期消息（保留段之外没有内容，或整段属于当前这一轮）。",
    };
  }
  if (input.ledger.length >= config.maxFolds) {
    return {
      folded: false,
      reason: "fold_limit",
      detail: `已达到单次分析的折叠上限 ${config.maxFolds} 次（${ONTOLOGY_INQUIRY_MAX_FOLDS_ENV}）。`,
    };
  }
  if (!input.archive) {
    return {
      folded: false,
      reason: "no_archive",
      detail:
        "本次分析没有配置无损归档存储：折叠会不可逆地销毁已读原文，因此不折叠。",
    };
  }

  const seq = input.ledger.length + 1;
  const now = input.now ?? Date.now();
  const entries = archiveEntriesFromDropped(
    dropped,
    seq,
    now,
    config.archiveContentCap,
  );
  // LOSSLESS OR NOT AT ALL. The check happens BEFORE the append, so a fold that
  // cannot retain everything leaves both the context and the archive untouched
  // — a partially-archived, half-truncated batch would be the worst of the two
  // worlds: destroyed originals plus a durable record claiming otherwise.
  const lossy = archiveTruncationReport(entries, config.archiveContentCap);
  if (lossy.truncated > 0) {
    return {
      folded: false,
      reason: "archive_lossy",
      detail: clip(
        `本次要移出的 ${entries.length} 条里有 ${lossy.truncated} 条超过单条归档上限 ${lossy.cap} 字符，无法逐字保留（${ONTOLOGY_INQUIRY_ARCHIVE_CONTENT_CAP_ENV}）。`,
        config.detailCap,
      ),
    };
  }
  try {
    await input.archive.append(entries);
  } catch (error) {
    return {
      folded: false,
      reason: "archive_failed",
      detail: clip(
        error instanceof Error ? error.message : String(error),
        config.detailCap,
      ),
    };
  }
  const { labels, total } = describeFoldedToolCalls(
    dropped,
    config.readLabelCap,
  );
  const record: OntologyInquiryFoldRecord = {
    seq,
    at: now,
    trigger: input.trigger,
    droppedMessages: dropped.length,
    droppedChars: dropped.reduce(
      (sum, message) => sum + estimateMessageChars(message),
      0,
    ),
    droppedToolResultChars: dropped.reduce(
      (sum, message) =>
        message.role === "tool"
          ? sum + String(message.content ?? "").length
          : sum,
      0,
    ),
    keptMessages: prefix.length + 1 + recent.length,
    archivedEntries: entries.length,
    archiveTruncatedEntries: lossy.truncated,
    archiveContentCap: lossy.cap,
    reads: labels.slice(0, config.readListCap),
    readsTotal: total,
  };
  input.ledger.push(record);

  // Only now — after the durable write resolved — is the live context changed.
  const notice: ChatMsg = {
    role: "system",
    content: buildFoldNoticeMessage(input.ledger, config),
  };
  messages.length = 0;
  messages.push(...prefix, notice, ...recent);
  return { folded: true, record };
}

// ── what the model is told ───────────────────────────────────────────────────

function fill(
  template: string,
  vars: Record<string, string | number>,
): string {
  return template.replace(/\{(\w+)\}/gu, (match, key: string) =>
    key in vars ? String(vars[key]) : match,
  );
}

/**
 * The synthetic system message that replaces the folded span.
 *
 * Built from the WHOLE ledger so an earlier fold's read names are not themselves
 * lost by a later fold, and carrying the conductor's three obligations: real
 * names (not counts), an explicit "this is compaction of the SAME analysis, do
 * not start over", and the retrieval path for the originals.
 */
export function buildFoldNoticeMessage(
  ledger: readonly OntologyInquiryFoldRecord[],
  config: OntologyInquiryCompactionConfig,
  recallToolName = ONTOLOGY_INQUIRY_RECALL_TOOL_NAME,
): string {
  const template = ONTOLOGY_INQUIRY_FOLD_TEMPLATE;
  const lines: string[] = [template.contextHeader];
  for (const record of ledger) {
    lines.push(
      fill(template.foldLine, {
        seq: record.seq,
        messages: record.droppedMessages,
        chars: record.droppedChars,
        resultChars: record.droppedToolResultChars,
        archived: record.archivedEntries,
      }),
    );
    if (record.archiveTruncatedEntries > 0) {
      lines.push(
        fill(template.lossyLine, {
          truncated: record.archiveTruncatedEntries,
          total: record.archivedEntries,
          cap: record.archiveContentCap,
        }),
      );
    }
  }
  // One merged, de-duplicated list across every fold: the model needs to know
  // WHAT has been read, not to re-derive it from per-fold fragments.
  const seen: string[] = [];
  let readsTotal = 0;
  for (const record of ledger) {
    readsTotal += record.readsTotal;
    for (const label of record.reads) if (!seen.includes(label)) seen.push(label);
  }
  const shown = seen.slice(0, config.readListCap);
  lines.push(template.readsHeader);
  lines.push(
    shown.length > 0
      ? fill(template.readsLine, { reads: shown.join("、") })
      : template.readsEmpty,
  );
  if (readsTotal > shown.length) {
    lines.push(
      fill(template.readsTruncated, {
        total: readsTotal,
        shown: shown.length,
      }),
    );
  }
  lines.push(fill(template.recallLine, { tool: recallToolName }));
  lines.push(template.continuityLine);
  return lines.join("\n");
}

/** Aggregate view of every fold — the machine-readable half of the report. */
export interface OntologyInquiryFoldReport {
  folds: number;
  droppedMessages: number;
  droppedChars: number;
  droppedToolResultChars: number;
  archivedEntries: number;
  archiveTruncatedEntries: number;
  archiveContentCap: number;
  /** Real, de-duplicated tool-call labels folded out, bounded. */
  foldedReads: string[];
  /** …of how many calls actually occurred across all folds. */
  foldedReadsTotal: number;
  /** The originals are retrievable (an archive was configured and written). */
  recallAvailable: boolean;
}

export function summariseFoldLedger(
  ledger: readonly OntologyInquiryFoldRecord[],
  config: OntologyInquiryCompactionConfig,
): OntologyInquiryFoldReport {
  const reads: string[] = [];
  for (const record of ledger) {
    for (const label of record.reads) {
      if (!reads.includes(label)) reads.push(label);
    }
  }
  return {
    folds: ledger.length,
    droppedMessages: ledger.reduce((sum, r) => sum + r.droppedMessages, 0),
    droppedChars: ledger.reduce((sum, r) => sum + r.droppedChars, 0),
    droppedToolResultChars: ledger.reduce(
      (sum, r) => sum + r.droppedToolResultChars,
      0,
    ),
    archivedEntries: ledger.reduce((sum, r) => sum + r.archivedEntries, 0),
    archiveTruncatedEntries: ledger.reduce(
      (sum, r) => sum + r.archiveTruncatedEntries,
      0,
    ),
    archiveContentCap: ledger.length
      ? ledger[ledger.length - 1]!.archiveContentCap
      : 0,
    foldedReads: reads.slice(0, config.readListCap),
    foldedReadsTotal: ledger.reduce((sum, r) => sum + r.readsTotal, 0),
    recallAvailable: ledger.length > 0,
  };
}

/** The caveat carried by the SHIPPED answer. A compacted analysis is never
 * presented as complete — including when a deliberated rewrite drops it, which
 * is why the marker is a stable constant the caller can test for. */
export function buildFoldAnswerNotice(
  report: OntologyInquiryFoldReport,
): string {
  return fill(ONTOLOGY_INQUIRY_FOLD_TEMPLATE.noticeBody, {
    mark: ONTOLOGY_INQUIRY_FOLD_TEMPLATE.noticeMark,
    folds: report.folds,
    messages: report.droppedMessages,
    chars: report.droppedChars,
    reads: report.foldedReadsTotal,
  });
}

/** The caveat carried by a partial answer that stopped BECAUSE the fold was
 * refused — the honest counterpart of the notice above. */
export function buildFoldRefusalNotice(detail: string): string {
  return fill(ONTOLOGY_INQUIRY_FOLD_TEMPLATE.refusedBody, {
    mark: ONTOLOGY_INQUIRY_FOLD_TEMPLATE.refusedMark,
    detail,
  });
}

// ── recall ───────────────────────────────────────────────────────────────────

export const ONTOLOGY_INQUIRY_RECALL_TOOL_NAME = "recall_evidence";
export const ONTOLOGY_INQUIRY_RECALL_LIMIT_DEFAULT = 6;
export const ONTOLOGY_INQUIRY_RECALL_LIMIT_MAX = 20;
/** Bound on ONE returned excerpt of archived original text. */
export const ONTOLOGY_INQUIRY_RECALL_EXCERPT_CHARS_ENV =
  "ONTOLOGY_INQUIRY_RECALL_EXCERPT_CHARS";
export const ONTOLOGY_INQUIRY_RECALL_EXCERPT_CHARS_DEFAULT = 2_000;

/**
 * One recalled original, ATTRIBUTED.
 *
 * The factory's `recall_conversation` renders only `{index, role, excerpt}` —
 * it stores `at` and `foldSeq` and then discards both, so the brain can quote a
 * recalled line but cannot say where in the conversation it sat or which fold
 * produced it. An unattributed recall injected into a prompt is indistinguishable
 * from the model's own invention, so all three are surfaced here.
 *
 * Honest limit: `archivedAt` is the moment the FOLD wrote the entry, not the
 * moment the turn happened — that timestamp is not captured anywhere in the
 * conversation. `index` (append-only archive position) and `foldSeq` are the
 * faithful ORDER; the clock is not.
 */
export interface OntologyInquiryRecallHit {
  index: number;
  role: string;
  foldSeq: number | null;
  archivedAt: string;
  excerpt: string;
  /** The stored entry was itself longer than the excerpt bound. */
  truncated: boolean;
}

export function renderRecallHits(
  hits: readonly ConversationArchiveSearchHit[],
  excerptCap: number,
): OntologyInquiryRecallHit[] {
  return hits.map((hit) => ({
    index: hit.index,
    role: hit.role,
    foldSeq: hit.foldSeq ?? null,
    archivedAt: new Date(hit.at).toISOString(),
    excerpt:
      hit.content.length > excerptCap
        ? `${hit.content.slice(0, excerptCap)}…`
        : hit.content,
    truncated: hit.content.length > excerptCap,
  }));
}
