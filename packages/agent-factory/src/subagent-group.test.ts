import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMsg, TurnEvent } from "./stream-gateway";

const seenTurns: ChatMsg[][] = [];
const scriptedTurns: TurnEvent[][] = [];
const savedConversationIds: string[] = [];

vi.mock("./stream-gateway", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./stream-gateway")>();
  return {
    ...actual,
    isGatewayConfigured: () => false, // → reduceGroup uses the deterministic stitch, no live chatOnce
    setLlmCallContext: () => undefined,
    streamTurn: async function* (messages: ChatMsg[]) {
      seenTurns.push(structuredClone(messages));
      const events = scriptedTurns.shift() ?? [{ t: "done" as const, content: "done" }];
      for (const event of events) yield event;
    },
  };
});

import { runBrain } from "./conductor";
import type { FactoryPorts } from "./ports";
import type { BrainEvent as Ev } from "./brain-types";

const ports = (): FactoryPorts => ({
  ontology: { listDomains: async () => [], fetchOntology: async () => ({ domainId: "dom", actions: [], events: [], objects: [], rules: [], workflow: [], source: "snapshot" }), fetchActionRules: async () => [] },
  sandbox: { deployAndObserve: async () => { throw new Error("not used"); }, teardown: async () => undefined },
  reflection: { list: async () => [], record: async () => undefined },
  conversation: {
    has: async () => false,
    load: async () => null,
    save: async (conversationId) => {
      savedConversationIds.push(conversationId);
    },
    drainHumanMessages: async () => [],
  },
});

const groupCall = (members: Array<{ role: string; task: string }>): TurnEvent[] => [
  { t: "tool_calls", content: "", calls: [{ id: "g1", name: "spawn_subagent_group", args: JSON.stringify({ reasoning: "需要分工并行", label: "测试组", members }) }] },
];

describe("spawn_subagent_group — reasoning-driven parallel sub-brain group", () => {
  beforeEach(() => {
    vi.stubEnv("FACTORY_AI_MODEL", "test/group-model");
    vi.stubEnv("FACTORY_GROUP_CONCURRENCY", "1"); // deterministic member order for scripting
    seenTurns.splice(0);
    scriptedTurns.splice(0);
    savedConversationIds.splice(0);
  });
  afterEach(() => vi.unstubAllEnvs());

  it("fans out members as isolated sub-brains, tags them with a shared groupId, and reduces their conclusions", async () => {
    scriptedTurns.push(
      groupCall([{ role: "甲", task: "查 A" }, { role: "乙", task: "查 B" }, { role: "丙", task: "查 C" }]),
      [{ t: "done", content: "结论 A" }],
      [{ t: "done", content: "结论 B" }],
      [{ t: "done", content: "结论 C" }],
      [{ t: "done", content: "父脑收尾" }],
    );

    const events: Ev[] = [];
    for await (const ev of runBrain({ domain: "dom", goal: "把问题拆给一组子脑", ports: ports(), conversationId: "grp-conv" })) events.push(ev);

    const start = events.find((e): e is Extract<Ev, { t: "group.start" }> => e.t === "group.start");
    expect(start).toBeTruthy();
    expect(start!.members).toBe(3);
    expect(start!.mode).toBe("research");

    const memberStarts = events.filter((e): e is Extract<Ev, { t: "subagent.start" }> => e.t === "subagent.start" && e.groupId === start!.groupId);
    const memberDones = events.filter((e): e is Extract<Ev, { t: "subagent.done" }> => e.t === "subagent.done" && e.groupId === start!.groupId);
    expect(memberStarts).toHaveLength(3);
    expect(memberDones).toHaveLength(3);

    const done = events.find((e): e is Extract<Ev, { t: "group.done" }> => e.t === "group.done");
    expect(done).toMatchObject({ ok: 3, total: 3, groupId: start!.groupId });
    expect(done!.summary).toContain("结论"); // the deterministic reduce stitched the members' conclusions
  });

  it("keeps child checkpoints isolated when display roles collide", async () => {
    scriptedTurns.push(
      groupCall([
        { role: "ruleCheckF设计", task: "设计 CandidateIdentity" },
        { role: "ruleCheckF设计", task: "设计 MatchResume" },
      ]),
      [{ t: "done", content: "Identity 结论" }],
      [{ t: "done", content: "Match 结论" }],
      [{ t: "done", content: "父脑收尾" }],
    );

    for await (const _event of runBrain({
      domain: "dom",
      goal: "验证同名子脑隔离",
      ports: ports(),
      conversationId: "collision-conv",
    })) {
      // Drain the stream so every child reaches its durable checkpoint.
    }

    const childIds = new Set(
      savedConversationIds.filter((id) =>
        id.startsWith("collision-conv:sub:"),
      ),
    );
    expect([...childIds]).toHaveLength(2);
  });

  it("enforces the tree-wide spawn cap: a group exceeding FACTORY_MAX_TREE_SPAWNS is refused before any member runs", async () => {
    vi.stubEnv("FACTORY_MAX_TREE_SPAWNS", "2");
    scriptedTurns.push(
      groupCall([{ role: "甲", task: "A" }, { role: "乙", task: "B" }, { role: "丙", task: "C" }]), // 3 > cap 2
      [{ t: "done", content: "父脑收尾" }],
    );

    const events: Ev[] = [];
    for await (const ev of runBrain({ domain: "dom", goal: "过量派生", ports: ports(), conversationId: "cap-conv" })) events.push(ev);

    // refused up front: no group ran, no members spawned
    expect(events.some((e) => e.t === "group.start")).toBe(false);
    expect(events.some((e) => e.t === "subagent.start")).toBe(false);
    expect(events).toContainEqual(expect.objectContaining({ t: "tool.result", name: "spawn_subagent_group", ok: false, summary: expect.stringContaining("上限") }));
  });

  it("rejects a degenerate group of fewer than 2 members (single task should use spawn_subagent)", async () => {
    scriptedTurns.push(
      groupCall([{ role: "独", task: "只有一个" }]),
      [{ t: "done", content: "父脑收尾" }],
    );
    const events: Ev[] = [];
    for await (const ev of runBrain({ domain: "dom", goal: "退化组", ports: ports(), conversationId: "one-conv" })) events.push(ev);
    expect(events.some((e) => e.t === "group.start")).toBe(false);
    expect(events).toContainEqual(expect.objectContaining({ t: "tool.result", name: "spawn_subagent_group", ok: false, summary: expect.stringContaining("至少要 2 个") }));
  });
});
