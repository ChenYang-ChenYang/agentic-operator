import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMsg, TurnEvent } from "./stream-gateway";

const seenTurns: ChatMsg[][] = [];
const scriptedTurns: TurnEvent[][] = [];

vi.mock("./stream-gateway", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./stream-gateway")>();
  return {
    ...actual,
    isGatewayConfigured: () => false,
    setLlmCallContext: () => undefined,
    streamTurn: async function* (messages: ChatMsg[]) {
      seenTurns.push(structuredClone(messages));
      const events = scriptedTurns.shift() ?? [{ t: "done" as const, content: "seed observed" }];
      for (const event of events) yield event;
    },
  };
});

import { runBrain } from "./conductor";
import { normalizeQuestion } from "./tools";
import type { BrainTool } from "./brain-types";
import type { FactoryHumanMemory, FactoryPorts } from "./ports";
import type { FactoryAuthorizationChallenge } from "./authorization-challenge";
import { INTEGRATION_PROFILE_AUTHORIZATION_PROTOCOL_VERSION } from "./integration-profile-authorization";

const now = "2026-07-13T00:00:00.000Z";
const memories: FactoryHumanMemory[] = [
  {
    id: "fhm-clarify",
    domain: "dom",
    questionKey: "clarify:1",
    kind: "clarify",
    question: "最低通过分是多少？",
    answer: "65 分",
    context: "用于候选人初筛",
    source: "human",
    conversationId: "old-conversation",
    confirmed: true,
    pinned: true,
    createdAt: now,
    updatedAt: now,
  },
  {
    id: "fhm-test",
    domain: "dom",
    questionKey: "test_approval:1",
    kind: "test_approval",
    question: "是否执行旧测试集？",
    answer: "执行",
    source: "human",
    confirmed: true,
    pinned: false,
    createdAt: now,
    updatedAt: now,
  },
];

describe("runBrain eager human-memory seed", () => {
  beforeEach(() => {
    // runBrain's router requires an explicit real model even though streamTurn
    // is replaced by the deterministic test generator below.
    vi.stubEnv("FACTORY_AI_MODEL", "test/human-memory-model");
    seenTurns.splice(0);
    scriptedTurns.splice(0);
  });

  afterEach(() => vi.unstubAllEnvs());

  it("loads confirmed memories into a fresh run as system BACKGROUND only — no cross-conversation ask_user replay, no humanDirectives injection", async () => {
    let snapshot: { messages: unknown[]; ctx: Record<string, unknown> } | undefined;
    const ports: FactoryPorts = {
      ontology: {
        listDomains: async () => [],
        fetchOntology: async () => ({ domainId: "dom", actions: [], events: [], objects: [], rules: [], workflow: [], source: "snapshot" }),
        fetchActionRules: async () => [],
      },
      sandbox: {
        deployAndObserve: async () => { throw new Error("not used"); },
        teardown: async () => undefined,
      },
      conversation: {
        has: async () => false,
        load: async () => null,
        save: async (_id, value) => { snapshot = value; },
        drainHumanMessages: async () => [],
      },
      reflection: {
        list: async () => [],
        record: async () => undefined,
      },
      humanMemory: {
        list: async (_domain, opts) => {
          expect(opts).toMatchObject({ confirmedOnly: true });
          return memories;
        },
        upsert: async () => { throw new Error("no gate answer occurred"); },
        pin: async () => false,
        del: async () => false,
      },
    };

    const events = [];
    for await (const event of runBrain({ domain: "dom", goal: "生成候选人筛选 agent", ports, conversationId: "new-conversation" })) {
      events.push(event);
    }

    expect(seenTurns).toHaveLength(1);
    const turn = seenTurns[0]!;
    const prompt = turn.map((message) => String(message.content ?? "")).join("\n");
    // Memories are still surfaced verbatim so the brain CAN reference them when relevant…
    expect(prompt).toContain("answer(verbatim): 65 分");
    expect(prompt).toContain("answer(verbatim): 执行");
    // …but as a SYSTEM background frame (not a leading role:user turn), clearly marked 仅背景 so a bare
    // "你好" doesn't make the brain open by recapping old decisions.
    const seedMsg = turn.find((message) => typeof message.content === "string" && message.content.includes("answer(verbatim): 65 分"));
    expect(seedMsg?.role).toBe("system");
    expect(String(seedMsg?.content)).toContain("仅背景");
    // Cross-conversation clarify answers are NOT pre-seeded into askedQuestions — so a fresh ask_user
    // genuinely PARKS instead of silently replaying a prior conversation's answer (an "ask_user 不暂停" cause).
    const asked = (snapshot?.ctx.askedQuestions as Record<string, string> | undefined) ?? {};
    expect(asked[normalizeQuestion("最低通过分是多少？")]).toBeUndefined();
    expect(asked[normalizeQuestion("是否执行旧测试集？")]).toBeUndefined();
    // The seed is NOT pushed into humanDirectives (which re-surface every turn as 人工介入指令 and dominate a greeting).
    expect((snapshot?.ctx.humanDirectives as string[]).join("\n")).not.toContain("用于候选人初筛");
    expect(events.at(-1)).toMatchObject({ t: "done" });
  });

  it("acknowledges a durable human-message lease only after its effect is checkpointed", async () => {
    const order: string[] = [];
    const snapshots: Array<{ messages: unknown[]; ctx: Record<string, unknown> }> = [];
    const deliveryId = "delivery-after-checkpoint";
    const ports: FactoryPorts = {
      ontology: {
        listDomains: async () => [],
        fetchOntology: async () => ({ domainId: "dom", actions: [], events: [], objects: [], rules: [], workflow: [], source: "snapshot" }),
        fetchActionRules: async () => [],
      },
      sandbox: { deployAndObserve: async () => { throw new Error("not used"); }, teardown: async () => undefined },
      conversation: {
        has: async () => false,
        load: async () => null,
        save: async (_id, value) => { order.push("save"); snapshots.push(structuredClone(value)); },
        drainHumanMessages: async () => {
          order.push("drain");
          return [{ text: "必须先落检查点再确认", actor: "usr-human", deliveryId }];
        },
        ackHumanMessages: async (_id, ackedId) => {
          order.push("ack");
          expect(ackedId).toBe(deliveryId);
          expect(JSON.stringify(snapshots.at(-1))).toContain("必须先落检查点再确认");
        },
      },
      reflection: { list: async () => [], record: async () => undefined },
    };

    for await (const _event of runBrain({ domain: "dom", goal: "test mailbox checkpoint", ports, conversationId: "mailbox-checkpoint" })) {
      // consume
    }

    expect(order.filter((entry) => entry === "ack")).toHaveLength(1);
    expect(order.indexOf("save")).toBeLessThan(order.indexOf("ack"));
    expect(seenTurns.flat().map((message) => String(message.content ?? "")).join("\n")).toContain("必须先落检查点再确认");
  });

  it("does not acknowledge a human-message lease when every checkpoint write fails", async () => {
    const ackHumanMessages = vi.fn(async () => undefined);
    const ports: FactoryPorts = {
      ontology: {
        listDomains: async () => [],
        fetchOntology: async () => ({ domainId: "dom", actions: [], events: [], objects: [], rules: [], workflow: [], source: "snapshot" }),
        fetchActionRules: async () => [],
      },
      sandbox: { deployAndObserve: async () => { throw new Error("not used"); }, teardown: async () => undefined },
      conversation: {
        has: async () => false,
        load: async () => null,
        save: async () => { throw new Error("checkpoint disk unavailable"); },
        drainHumanMessages: async () => [{ text: "不能因保存失败而丢失", deliveryId: "delivery-unacked" }],
        ackHumanMessages,
      },
      reflection: { list: async () => [], record: async () => undefined },
    };

    const events = [];
    for await (const event of runBrain({ domain: "dom", goal: "test failed checkpoint", ports, conversationId: "mailbox-failed-checkpoint" })) {
      events.push(event);
    }

    expect(ackHumanMessages).not.toHaveBeenCalled();
    expect(events).toContainEqual(expect.objectContaining({ t: "error", message: expect.stringContaining("checkpoint disk unavailable") }));
    expect(events.at(-1)).toMatchObject({ t: "done", status: "errored" });
  });

  it("checkpoints and acks a wrongly routed gate message before polling a newer reply", async () => {
    let mailboxReads = 0;
    const acked: string[] = [];
    let interactionId = "";
    const gateTool: BrainTool = {
      name: "open_test_gate_for_ack",
      effect: {
        sideEffect: "write",
        scope: "conversation",
        checkpoint: "turn",
        gate: "any",
      },
      description: "test-only gate",
      parameters: { type: "object", properties: {} },
      async execute(_args, ctx) {
        ctx.awaitingApproval = true;
        ctx.testCases = [{
          id: "tc-ack",
          name: "ack sequencing",
          scenario: "wrong tag arrives before approval",
          kind: "pass",
          entryEvent: "START",
          payload: {},
          expectedOutcome: "PASS",
        }];
        return { ok: true, summary: "gate opened" };
      },
    };
    scriptedTurns.push(
      [{ t: "tool_calls", content: "", calls: [{ id: "call-ack-gate", name: gateTool.name, args: "{}" }] }],
      [{ t: "done", content: "approval consumed" }],
    );
    const ports: FactoryPorts = {
      ontology: {
        listDomains: async () => [],
        fetchOntology: async () => ({ domainId: "dom", actions: [], events: [], objects: [], rules: [], workflow: [], source: "snapshot" }),
        fetchActionRules: async () => [],
      },
      sandbox: { deployAndObserve: async () => { throw new Error("not used"); }, teardown: async () => undefined },
      conversation: {
        has: async () => false,
        load: async () => null,
        save: async (_id, snapshot) => {
          interactionId = String(((snapshot.ctx.humanInteractions as Record<string, Record<string, unknown>> | undefined)?.test_approval?.interactionId) ?? interactionId);
        },
        drainHumanMessages: async () => {
          mailboxReads += 1;
          if (mailboxReads === 2) return [{ text: "[边界事件决策] []", deliveryId: "delivery-wrong-gate", interactionId: "hitl_00000000-0000-0000-0000-000000000000", gateKind: "boundary" as const }];
          if (mailboxReads === 3) {
            expect(acked).toContain("delivery-wrong-gate");
            return [{ text: "[测试用例决策：执行]", deliveryId: "delivery-correct-gate", interactionId, gateKind: "test_approval" as const }];
          }
          return [];
        },
        ackHumanMessages: async (_id, deliveryId) => { acked.push(deliveryId); },
      },
      reflection: { list: async () => [], record: async () => undefined },
    };

    const events = [];
    for await (const event of runBrain({ domain: "dom", goal: "test gate ordering", ports, tools: [gateTool], conversationId: "gate-ordering" })) {
      events.push(event);
    }

    expect(events).toContainEqual(expect.objectContaining({ t: "test.decision", decision: "approve" }));
    expect(acked).toEqual(expect.arrayContaining(["delivery-wrong-gate", "delivery-correct-gate"]));
  });

  it("durably records a stop and preserves its batch peers before acknowledging the lease", async () => {
    let snapshot: { messages: unknown[]; ctx: Record<string, unknown> } | undefined;
    const ackHumanMessages = vi.fn(async () => undefined);
    const ports: FactoryPorts = {
      ontology: {
        listDomains: async () => [],
        fetchOntology: async () => ({ domainId: "dom", actions: [], events: [], objects: [], rules: [], workflow: [], source: "snapshot" }),
        fetchActionRules: async () => [],
      },
      sandbox: { deployAndObserve: async () => { throw new Error("not used"); }, teardown: async () => undefined },
      conversation: {
        has: async () => false,
        load: async () => null,
        save: async (_id, value) => { snapshot = structuredClone(value); },
        drainHumanMessages: async () => [
          { text: "停止", deliveryId: "delivery-stop" },
          { text: "下一次仍需处理的补充", deliveryId: "delivery-stop" },
        ],
        ackHumanMessages,
      },
      reflection: { list: async () => [], record: async () => undefined },
    };

    const events = [];
    for await (const event of runBrain({ domain: "dom", goal: "test durable stop", ports, conversationId: "durable-stop" })) {
      events.push(event);
    }

    expect(events).toContainEqual(expect.objectContaining({ t: "message", text: expect.stringContaining("立即停止") }));
    expect(snapshot?.ctx.humanDirectives).toContain("用户请求停止本次运行");
    expect(snapshot?.ctx.pendingHuman).toEqual(expect.arrayContaining([
      expect.objectContaining({ text: "下一次仍需处理的补充", deliveryId: "delivery-stop" }),
    ]));
    expect(JSON.stringify(snapshot?.ctx.pendingHuman)).not.toContain('"text":"停止"');
    expect(ackHumanMessages).toHaveBeenCalledOnce();
    expect(ackHumanMessages).toHaveBeenCalledWith("durable-stop", "delivery-stop");
  });

  it.each([
    {
      label: "clarify",
      human: "[澄清回答] 65 分",
      configure(ctx: Parameters<BrainTool["execute"]>[1]) {
        ctx.awaitingClarify = true;
        ctx.clarifyPrompt = { question: "最低通过分是多少？", context: "候选人初筛" };
      },
      expectedKind: "clarify",
      expectedAnswer: "65 分",
    },
    {
      label: "test approval",
      human: "[测试用例决策：执行] 保留 fault case",
      configure(ctx: Parameters<BrainTool["execute"]>[1]) {
        ctx.awaitingApproval = true;
        ctx.testCases = [{
          id: "tc-1",
          name: "fault",
          scenario: "upstream timeout",
          kind: "fault",
          entryEvent: "START",
          payload: {},
          expectedOutcome: "FAIL terminal",
        }];
      },
      expectedKind: "test_approval",
      expectedAnswer: "[测试用例决策：执行] 保留 fault case",
    },
    {
      label: "boundary",
      human: "[边界事件决策] [{\"event\":\"HANDOFF\",\"kind\":\"external\",\"consumer\":\"ATS\"}]",
      configure(ctx: Parameters<BrainTool["execute"]>[1]) {
        ctx.awaitingBoundary = true;
        ctx.boundaryProposals = [{ event: "HANDOFF", suggestedKind: "external", why: "external ATS", producers: ["a"] }];
      },
      expectedKind: "boundary",
      expectedAnswer: "[边界事件决策] [{\"event\":\"HANDOFF\",\"kind\":\"external\",\"consumer\":\"ATS\"}]",
    },
  ])("persists a human $label decision immediately at the gate", async ({ human, configure, expectedKind, expectedAnswer }) => {
    const writes: Array<Record<string, unknown>> = [];
    let mailboxReads = 0;
    const gateTool: BrainTool = {
      name: "open_gate",
      effect: {
        sideEffect: "write",
        scope: "conversation",
        checkpoint: "turn",
        gate: "any",
      },
      description: "test-only gate",
      parameters: { type: "object", properties: {} },
      async execute(_args, ctx) {
        configure(ctx);
        return { ok: true, summary: "gate opened" };
      },
    };
    scriptedTurns.push(
      [{ t: "tool_calls", content: "", calls: [{ id: "call-1", name: "open_gate", args: "{}" }] }],
      [{ t: "done", content: "decision consumed" }],
    );
    const ports: FactoryPorts = {
      ontology: {
        listDomains: async () => [],
        fetchOntology: async () => ({ domainId: "dom", actions: [], events: [], objects: [], rules: [], workflow: [], source: "snapshot" }),
        fetchActionRules: async () => [],
      },
      sandbox: { deployAndObserve: async () => { throw new Error("not used"); }, teardown: async () => undefined },
      conversation: {
        has: async () => false,
        load: async () => null,
        save: async () => undefined,
        // First loop's ordinary mailbox read sees nothing.  The next loop is
        // parked on the gate and receives the human decision.
        drainHumanMessages: async () => (++mailboxReads === 1 ? [] : [{ text: human, actor: "usr-human" }]),
      },
      reflection: { list: async () => [], record: async () => undefined },
      humanMemory: {
        list: async () => [],
        upsert: async (_domain, value) => {
          writes.push(value);
          return { id: "fhm-written", domain: "dom", ...value, confirmed: true, pinned: false, createdAt: now, updatedAt: now };
        },
        pin: async () => false,
        del: async () => false,
      },
    };
    for await (const _event of runBrain({ domain: "dom", goal: "test gate", ports, tools: [gateTool], conversationId: "new-gate-conversation" })) {
      // consume
    }
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ kind: expectedKind, source: "human", answer: expectedAnswer, conversationId: "new-gate-conversation" });
  });

  it("keeps a fresh parked authorization answer out of model messages and the conversation checkpoint", async () => {
    const token = `authorize_probe:v2:${"a".repeat(64)}`;
    const challenge: FactoryAuthorizationChallenge = {
      id: "fac-fresh",
      kind: "probe",
      protocolVersion: 2,
      digest: "a".repeat(64),
      subjectDigest: "b".repeat(64),
      token,
      question: "是否只执行这一次真实写 probe？",
      context: `probe_authorization:v2:${"a".repeat(64)}`,
      options: [
        { label: "先不执行", value: `decline_probe:v2:${"a".repeat(64)}`, recommended: true },
        { label: "确认只执行这一次", value: token, recommended: false },
      ],
      runId: "auth-fresh",
      conversationId: "auth-fresh",
      expiresAt: "2099-01-01T00:00:00.000Z",
    };
    let mailboxReads = 0;
    let snapshot: { messages: unknown[]; ctx: Record<string, unknown> } | undefined;
    const gateTool: BrainTool = {
      name: "open_authorization_gate",
      effect: {
        sideEffect: "write",
        scope: "conversation",
        checkpoint: "turn",
        gate: "any",
      },
      description: "test-only authorization gate",
      parameters: { type: "object", properties: {} },
      async execute(_args, ctx) {
        ctx.pendingAuthorizationChallenges = { [challenge.context]: challenge };
        ctx.clarifyPrompt = { question: challenge.question, context: challenge.context, options: challenge.options };
        ctx.awaitingClarify = true;
        return { ok: true, summary: "server challenge parked" };
      },
    };
    scriptedTurns.push(
      [{ t: "tool_calls", content: "", calls: [{ id: "call-auth", name: gateTool.name, args: "{}" }] }],
      [{ t: "done", content: "authorization state observed" }],
    );
    const ports: FactoryPorts = {
      ontology: {
        listDomains: async () => [],
        fetchOntology: async () => ({ domainId: "dom", actions: [], events: [], objects: [], rules: [], workflow: [], source: "snapshot" }),
        fetchActionRules: async () => [],
      },
      sandbox: { deployAndObserve: async () => { throw new Error("not used"); }, teardown: async () => undefined },
      conversation: {
        has: async () => false,
        load: async () => null,
        save: async (_id, value) => { snapshot = value; },
        drainHumanMessages: async () => (++mailboxReads === 2 ? [{ text: token, actor: "usr-responder" }] : []),
      },
      reflection: { list: async () => [], record: async () => undefined },
      authorizationChallenges: {
        issue: async () => challenge,
        restore: async () => challenge,
        consume: async () => { throw new Error("not used"); },
      },
    };
    for await (const _event of runBrain({ domain: "dom", goal: "open gate", ports, tools: [gateTool], conversationId: challenge.conversationId })) {
      // consume
    }
    expect(JSON.stringify(seenTurns)).not.toContain(token);
    expect(JSON.stringify(seenTurns)).toContain("用户已确认该服务端挑战");
    expect(JSON.stringify(snapshot)).not.toContain(token);
    expect(JSON.stringify(snapshot?.ctx)).toContain("$factory_authorization_confirmed");
  });

  it("rehydrates a redacted authorization checkpoint on resume without exposing the answer to the model", async () => {
    const token = `authorize_integration_profile:v3:${"c".repeat(64)}`;
    const interactionId = "hitl_44444444-4444-4444-8444-444444444444";
    const challenge: FactoryAuthorizationChallenge = {
      id: "fac-resume",
      kind: "integration_profile",
      protocolVersion: INTEGRATION_PROFILE_AUTHORIZATION_PROTOCOL_VERSION,
      digest: "c".repeat(64),
      subjectDigest: "d".repeat(64),
      token,
      question: "是否确认保存这套配置？",
      context: `integration_profile_authorization:v3:${"c".repeat(64)}`,
      options: [
        { label: "暂不保存", value: `decline_integration_profile:v3:${"c".repeat(64)}`, recommended: true },
        { label: "确认保存", value: token, recommended: false },
      ],
      runId: "auth-resume",
      conversationId: "auth-resume",
      expiresAt: "2099-01-01T00:00:00.000Z",
    };
    let snapshot: { messages: unknown[]; ctx: Record<string, unknown> } | undefined;
    let delivered = false;
    const restore = vi.fn(async () => challenge);
    const ports: FactoryPorts = {
      ontology: {
        listDomains: async () => [],
        fetchOntology: async () => ({ domainId: "dom", actions: [], events: [], objects: [], rules: [], workflow: [], source: "snapshot" }),
        fetchActionRules: async () => [],
      },
      sandbox: { deployAndObserve: async () => { throw new Error("not used"); }, teardown: async () => undefined },
      conversation: {
        has: async () => true,
        load: async () => ({
          messages: [
            { role: "system", content: "old system" },
            { role: "user", content: `legacy leaked value ${token}` },
          ],
          ctx: {
            domain: "dom",
            goal: "old",
            specs: [],
            ontology: null,
            budget: { maxTokens: null, maxTurns: 20 },
            spent: { tokens: 0, turns: 0, sandboxRuns: 0 },
            currentPlan: null,
            toolCatalog: [],
            attemptHistory: {},
            lastValidation: null,
            humanDirectives: [],
            priorReflections: [],
            createdSkills: [],
            awaitingClarify: true,
            humanInteractions: {
              clarify: { interactionId, kind: "clarify", subjectDigest: "e".repeat(64), createdAt: Date.now() },
            },
            clarifyPrompt: {
              question: challenge.question,
              context: challenge.context,
              options: challenge.options.map((option) => ({ ...option, value: option.value === token ? "$factory_authorization_confirmed" : "$factory_authorization_declined" })),
            },
            pendingAuthorizationChallenges: {
              [challenge.context]: {
                id: challenge.id,
                kind: challenge.kind,
                protocolVersion: challenge.protocolVersion,
                digest: challenge.digest,
                subjectDigest: challenge.subjectDigest,
                runId: challenge.runId,
                conversationId: challenge.conversationId,
                expiresAt: challenge.expiresAt,
              },
            },
          },
        }),
        save: async (_id, value) => { snapshot = value; },
        drainHumanMessages: async () => {
          if (delivered) return [];
          delivered = true;
          return [{
            text: `[澄清回答] ${token}`,
            actor: "usr-responder",
            interactionId,
            gateKind: "clarify",
          }];
        },
      },
      reflection: { list: async () => [], record: async () => undefined },
      authorizationChallenges: {
        issue: async () => challenge,
        restore,
        consume: async () => { throw new Error("not used"); },
      },
    };
    scriptedTurns.push([{ t: "done", content: "resume observed" }]);
    for await (const _event of runBrain({
      domain: "dom",
      goal: token,
      ports,
      tools: [],
      conversationId: challenge.conversationId,
      authenticatedActor: "usr-responder",
      continuationMode: "human_gate_resume",
    })) {
      // consume
    }
    expect(restore).toHaveBeenCalledOnce();
    expect(JSON.stringify(seenTurns)).not.toContain(token);
    expect(JSON.stringify(seenTurns)).toContain("用户已确认该服务端挑战");
    expect(JSON.stringify(snapshot)).not.toContain(token);
    expect(JSON.stringify(snapshot?.ctx)).toContain("$factory_authorization_confirmed");
  });
});
