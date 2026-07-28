import { describe, expect, it } from "vitest";
import {
  archiveEntriesFromDropped,
  archiveTruncationReport,
  recallConversationTool,
  searchArchiveEntries,
  type ConversationArchiveEntry,
  type FactoryConversationArchive,
} from "./conversation-archive";
import type { BrainCtx } from "./brain-types";
import type { ChatMsg } from "./stream-gateway";

describe("#CONV-ARCHIVE — entry serialization", () => {
  it("keeps role + verbatim text, serializes tool_calls, and preserves intra-batch order", () => {
    const dropped: ChatMsg[] = [
      { role: "user", content: "请确认人工边界 Internal_Recruitment_System" },
      { role: "assistant", content: "我按唯一候选选定了规则工具。", tool_calls: [{ id: "c1", function: { name: "design_agent", arguments: "{\"action\":\"createJD\"}" } }] } as ChatMsg,
      { role: "tool", content: { ok: true, summary: "已提交" } } as unknown as ChatMsg,
    ];
    const entries = archiveEntriesFromDropped(dropped, 3, 1000);
    expect(entries).toHaveLength(3);
    expect(entries[0]).toMatchObject({ role: "user", foldSeq: 3, at: 1000 });
    expect(entries[0]!.content).toContain("Internal_Recruitment_System");
    expect(entries[1]!.at).toBe(1001); // order survives identical clock reads
    expect(entries[1]!.content).toContain("[tool_calls]");
    expect(entries[1]!.content).toContain("design_agent");
    expect(entries[2]!.content).toContain("已提交"); // non-string content JSON-serialized
  });

  it("keeps content the old 4,000-char cap would have destroyed", () => {
    // 归档的唯一职责是让不可逆折叠可恢复。上限曾是 4,000 字，恰好砍掉最值得留
    // 的东西——实测一条真实会话 189 条里 58 条被截断，含四份权威 Action 契约。
    const big = "x".repeat(9_000);
    const [entry] = archiveEntriesFromDropped([{ role: "assistant", content: big }], 1, 0);
    expect(entry!.content).toBe(big);
    expect(entry!.content).not.toContain("截断");
  });

  it("still caps, and says so honestly, beyond the configured limit", () => {
    const huge = "x".repeat(70_000);
    const [entry] = archiveEntriesFromDropped([{ role: "assistant", content: huge }], 1, 0);
    expect(entry!.content.length).toBeLessThan(70_000);
    expect(entry!.content).toContain("截断");
    expect(entry!.content).toContain("70000");
  });

  it("reports a lossy batch as a fact, not just as text buried in one entry", () => {
    const entries = archiveEntriesFromDropped(
      [
        { role: "assistant", content: "x".repeat(70_000) },
        { role: "assistant", content: "short" },
      ],
      1,
      0,
    );
    expect(archiveTruncationReport(entries)).toMatchObject({ truncated: 1 });
    expect(archiveTruncationReport(entries).cap).toBeGreaterThanOrEqual(64_000);
  });
});

describe("#CONV-ARCHIVE — pure search", () => {
  const entries: ConversationArchiveEntry[] = [
    { at: 1, role: "user", content: "规则读取工具选 ontology.fetchActionRules" },
    { at: 2, role: "assistant", content: "createJD 用 facts.query 读取需求" },
    { at: 3, role: "user", content: "确认人工边界 Internal_Recruitment_System" },
  ];

  it("AND-matches all whitespace-separated terms, case-insensitive, most-recent-first with stable index", () => {
    const hits = searchArchiveEntries(entries, "internal_recruitment 边界", 10);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ index: 2, role: "user" });
    const multi = searchArchiveEntries(entries, "工具", 10);
    expect(multi.map((h) => h.index)).toEqual([0]); // only entry 0 mentions 工具
  });

  it("empty query → no hits; limit respected newest-first", () => {
    expect(searchArchiveEntries(entries, "   ", 10)).toEqual([]);
    const limited = searchArchiveEntries(entries, "读取", 1);
    expect(limited).toHaveLength(1);
    expect(limited[0]!.index).toBe(1); // newest matching entry wins under the cap
  });
});

function fakeCtx(archive: FactoryConversationArchive | undefined, conversationId?: string): BrainCtx {
  return {
    domain: "test", goal: "g", emit: () => {}, specs: [], ontology: null, currentPlan: null,
    toolCatalog: [], realTools: [], attemptHistory: {}, createdSkills: [], research: [],
    priorReflections: [], humanDirectives: [], lastSandbox: null, lastValidation: null,
    budget: { maxTokens: null, maxTurns: 1 }, spent: { tokens: 0, turns: 0, sandboxRuns: 0 },
    conversationId,
    ports: { conversationArchive: archive } as unknown as BrainCtx["ports"],
  } as unknown as BrainCtx;
}

describe("#CONV-ARCHIVE — recall_conversation tool", () => {
  const stocked: FactoryConversationArchive = {
    append: async () => {},
    search: async (_id, query) => (query.includes("边界")
      ? [{ at: 3, index: 2, role: "user", content: "确认人工边界 Internal_Recruitment_System", foldSeq: 1 }]
      : []),
    count: async () => 5,
  };

  it("returns verbatim hits with total coverage", async () => {
    const res = await recallConversationTool.execute({ reasoning: "核对", query: "边界" }, fakeCtx(stocked, "frn-1"));
    expect(res.ok).toBe(true);
    const out = res.output as { total: number; hits: Array<{ excerpt: string; index: number }> };
    expect(out.total).toBe(5);
    expect(out.hits[0]!.excerpt).toContain("Internal_Recruitment_System");
    expect(out.hits[0]!.index).toBe(2);
  });

  it("no-match is an honest ok with total context; empty archive says the content is still in-context", async () => {
    const res = await recallConversationTool.execute({ reasoning: "找", query: "不存在词" }, fakeCtx(stocked, "frn-1"));
    expect(res.ok).toBe(true);
    expect(String(res.summary)).toContain("没有同时命中");
    const empty: FactoryConversationArchive = { append: async () => {}, search: async () => [], count: async () => 0 };
    const res2 = await recallConversationTool.execute({ reasoning: "找", query: "x" }, fakeCtx(empty, "frn-1"));
    expect(String(res2.summary)).toContain("归档为空");
  });

  it("fails plainly without a configured archive or conversation id; archive errors are reported not swallowed", async () => {
    expect((await recallConversationTool.execute({ reasoning: "r", query: "x" }, fakeCtx(undefined, "frn-1"))).ok).toBe(false);
    expect((await recallConversationTool.execute({ reasoning: "r", query: "x" }, fakeCtx(stocked, undefined))).ok).toBe(false);
    const broken: FactoryConversationArchive = {
      append: async () => {}, count: async () => 1,
      search: async () => { throw new Error("disk offline"); },
    };
    const res = await recallConversationTool.execute({ reasoning: "r", query: "x" }, fakeCtx(broken, "frn-1"));
    expect(res.ok).toBe(false);
    expect(String(res.summary)).toContain("disk offline");
  });
});
