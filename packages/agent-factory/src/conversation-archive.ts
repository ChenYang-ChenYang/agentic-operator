// #CONV-ARCHIVE — lossless retention for compacted conversation turns.
//
// Auto-compaction (conductor.maybeCompact) folds early turns into a structured state summary plus a
// best-effort abstractive narrative. Both are LOSSY by construction: the dropped ChatMsgs themselves
// were gone — the brain could never quote, re-check, or be corrected against what was actually said
// ("每次 compact 都丢对话和记忆"). This module closes that gap with the two-tier design the team
// already adopted from the grok-build analysis (JSONL 真源 + 检索门控):
//
//   1. BEFORE a fold drops turns, they are appended verbatim to a durable per-conversation archive
//      (NDJSON, api-side FS store). If the archive write FAILS the fold is DEFERRED — context grows
//      until the archive recovers; silent loss is never an outcome.
//   2. A `recall_conversation` brain tool searches the archive on demand, so folded turns stay one
//      retrieval away instead of irrecoverable. The state summary advertises it.
//
// The port is optional: embedded/test contexts without an archive keep today's behavior (fold
// without retention) — but the conductor only relaxes to that when NO port is configured, never
// when a configured port errors.

import type { ChatMsg } from "./stream-gateway";
import type { BrainTool } from "./brain-types";

/** One archived turn. `content` is the exact text the model saw/produced (tool traffic is
 * serialized compactly but verbatim-enough to quote); never a paraphrase. */
export interface ConversationArchiveEntry {
  /** unix-ms at archive time (archival order == conversational order). */
  at: number;
  role: string;
  content: string;
  /** best-effort provenance: which fold wrote this batch. */
  foldSeq?: number;
}

export interface ConversationArchiveSearchHit extends ConversationArchiveEntry {
  /** 0-based position in the archive file — stable citation for follow-ups. */
  index: number;
}

/** Durable archive port (api implements FS NDJSON per tenant/domain/conversation). */
export interface FactoryConversationArchive {
  append(conversationId: string, entries: ConversationArchiveEntry[]): Promise<void>;
  /** Case-insensitive AND-match over whitespace-separated terms; most-recent-first. */
  search(conversationId: string, query: string, opts?: { limit?: number }): Promise<ConversationArchiveSearchHit[]>;
  /** Total archived entries (cheap; lets the tool report coverage honestly). */
  count(conversationId: string): Promise<number>;
}

// 归档存在的唯一理由，是让一次【不可逆的折叠】仍然可恢复。上限设成 4,000 字时，
// 它恰好把最值得留的东西砍掉：实测一条真实会话 189 条归档里有 58 条被截断，
// 其中包括四份权威 Action 契约——折叠之后原文就没了，截断即永久损失。
//
// 存储在文件系统（FsConversationArchiveStore，NDJSON），磁盘不是瓶颈；
// 这里对齐系统在别处已经接受的最大单体（FACTORY_UI_OUTPUT_CAP 默认 64,000）。
// 仍然保留上限：一条 400KB 的工具输出进归档也不合理，但截断必须被【报出来】。
const DEFAULT_CONTENT_CAP = 64_000;
function contentCap(): number {
  const configured = Number(process.env.FACTORY_ARCHIVE_CONTENT_CAP);
  return Number.isFinite(configured) && configured >= 1_000
    ? Math.floor(configured)
    : DEFAULT_CONTENT_CAP;
}

/** Serialize dropped ChatMsgs into archive entries. Tool calls/results keep their JSON payloads
 * (capped) so a recall can show real arguments/outputs, not just "called a tool". */
export function archiveEntriesFromDropped(dropped: ChatMsg[], foldSeq: number, now: number): ConversationArchiveEntry[] {
  const cap = contentCap();
  return dropped.map((message, i) => {
    let content: string;
    if (typeof message.content === "string") {
      content = message.content;
    } else {
      try {
        content = JSON.stringify(message.content);
      } catch {
        content = String(message.content);
      }
    }
    const calls = (message as { tool_calls?: unknown }).tool_calls;
    if (calls !== undefined) {
      try {
        content += `\n[tool_calls] ${JSON.stringify(calls)}`;
      } catch { /* keep text-only */ }
    }
    return {
      at: now + i, // preserve intra-batch order under identical clock reads
      role: message.role,
      content: content.length > cap ? `${content.slice(0, cap)}…[截断，原文 ${content.length} 字]` : content,
      foldSeq,
    };
  });
}

/** Pure search used by the api store (and tests): whitespace-separated terms, ALL must match,
 * case-insensitive; most-recent-first. Exported so store implementations cannot drift. */
export function searchArchiveEntries(
  entries: ConversationArchiveEntry[],
  query: string,
  limit: number,
): ConversationArchiveSearchHit[] {
  const terms = query.toLowerCase().split(/\s+/).map((t) => t.trim()).filter(Boolean);
  if (!terms.length) return [];
  const hits: ConversationArchiveSearchHit[] = [];
  for (let i = entries.length - 1; i >= 0 && hits.length < limit; i--) {
    const entry = entries[i]!;
    const haystack = `${entry.role}\n${entry.content}`.toLowerCase();
    if (terms.every((t) => haystack.includes(t))) hits.push({ ...entry, index: i });
  }
  return hits;
}

const HIT_PREVIEW_CAP = 700;

/** recall_conversation — retrieve folded conversation turns verbatim. Registered in FACTORY_TOOLS. */
export const recallConversationTool: BrainTool = {
  name: "recall_conversation",
  description:
    "检索本会话被上下文压缩折叠掉的【对话原文】（含早期用户消息、你自己的推理回复、工具调用与结果）。当你需要引用/核对早期对话细节、用户此前的具体表述或某次工具的真实输入输出，而状态摘要不够时用它。关键词以空格分隔（全部命中才返回），返回最近命中的原文片段。",
  parameters: {
    type: "object",
    properties: {
      reasoning: { type: "string", description: "为什么需要找回这段原文（一句话）" },
      query: { type: "string", description: "空格分隔的关键词，如 “人工边界 Internal_Recruitment”" },
      limit: { type: "number", description: "最多返回几条（默认 6，上限 20）" },
    },
    required: ["reasoning", "query"],
  },
  async execute(args, ctx) {
    const archive = ctx.ports.conversationArchive;
    if (!archive) {
      return { ok: false, summary: "当前部署没有配置会话归档存储，折叠原文不可检索（仅状态摘要可用）。" };
    }
    if (!ctx.conversationId) {
      return { ok: false, summary: "当前上下文没有会话 id，无法定位归档。" };
    }
    const query = String(args.query ?? "").trim();
    if (!query) return { ok: false, summary: "query 不能为空：给出要找回内容的关键词。" };
    const limit = Math.max(1, Math.min(20, Number(args.limit) || 6));
    try {
      const [hits, total] = await Promise.all([
        archive.search(ctx.conversationId, query, { limit }),
        archive.count(ctx.conversationId),
      ]);
      if (!total) {
        return { ok: true, summary: "本会话还没有折叠过任何对话（归档为空）——你要找的内容应该仍在当前上下文里。", output: { total: 0, hits: [] } };
      }
      if (!hits.length) {
        return {
          ok: true,
          summary: `归档共 ${total} 条折叠原文，但没有同时命中全部关键词「${query}」的条目。试试更少或更换关键词。`,
          output: { total, hits: [] },
        };
      }
      const rendered = hits.map((h) => ({
        index: h.index,
        role: h.role,
        excerpt: h.content.length > HIT_PREVIEW_CAP ? `${h.content.slice(0, HIT_PREVIEW_CAP)}…` : h.content,
      }));
      return {
        ok: true,
        summary: `从 ${total} 条折叠原文中命中 ${hits.length} 条（最近优先）。这些是当时的逐字记录，可直接引用。`,
        output: { total, hits: rendered },
      };
    } catch (error) {
      return { ok: false, summary: `会话归档读取失败：${(error as Error).message}。归档数据仍在，稍后重试。` };
    }
  },
};

/** 本批归档里被截断的条数与原文总字数。折叠是不可逆的，所以「这次归档是有损的」
 *  必须是一个可见事实，而不是埋在某条 content 字符串末尾的一句话。 */
export function archiveTruncationReport(
  entries: readonly ConversationArchiveEntry[],
): { truncated: number; cap: number } {
  const cap = contentCap();
  return {
    truncated: entries.filter((entry) => entry.content.endsWith("字]")
      && entry.content.includes("…[截断，原文 ")).length,
    cap,
  };
}
