import { describe, expect, it, vi } from "vitest";

import type { BrainCtx } from "./brain-types";
import {
  FACTORY_AUTHORIZATION_PROTOCOL_VERSION,
  type FactoryAuthorizationChallenge,
  type FactoryAuthorizationChallengeStore,
} from "./authorization-challenge";
import { FACTORY_TOOLS, normalizeQuestion } from "./tools";

const signedFixtureTool = FACTORY_TOOLS.find((tool) => tool.name === "create_signed_fixture")!;

function context() {
  const realTool = {
    name: "vendor.lookup",
    sideEffect: "read" as const,
    operation: "read" as const,
    effectScope: "external" as const,
    sandboxPolicy: "live_external" as const,
    capabilities: [{ systems: ["Vendor"], kinds: ["external_api"], roles: ["reads"], operations: ["lookup"] }],
    catalogDefinition: {
      name: "vendor.lookup",
      category: "vendor",
      sideEffect: "read" as const,
      operation: "read" as const,
      effectScope: "external" as const,
      sandboxPolicy: "live_external" as const,
      argsSchema: { id: { type: "string", required: true } },
      returnsSchema: { ok: { type: "boolean", required: true } },
      configSchema: { region: { type: "string", required: true } },
    },
  };
  const preparation = {
    subjectDigest: "c".repeat(64),
    definitionHash: "a".repeat(64),
    schemaHash: "b".repeat(64),
    configHash: "d".repeat(64),
    recordedAt: "2026-07-16T00:00:00.000Z",
    expiresAt: "2099-07-16T00:00:00.000Z",
    review: ["#1 input 12345678 → HTTP 200; response {\"ok\":true}"],
  };
  const prepareSignedFixture = vi.fn(async () => preparation);
  const createSignedFixture = vi.fn(async () => ({
    ...preparation,
    verified: true as const,
    evidenceMode: "signed-fixture" as const,
    cassettePath: "/tmp/cassette.json",
    attestationKeyId: "cassette-hmac-test",
    attestationExpiresAt: preparation.expiresAt,
    confirmedBy: "usr-reviewer",
  }));
  let issued: FactoryAuthorizationChallenge | undefined;
  let consumed = false;
  const authorizationChallenges: FactoryAuthorizationChallengeStore = {
    issue: vi.fn(async (_domain, input) => {
      const digest = "e".repeat(64);
      const token = `authorize_probe:v2:${digest}`;
      issued = {
        id: "fac-fixture-1",
        kind: input.kind,
        protocolVersion: FACTORY_AUTHORIZATION_PROTOCOL_VERSION,
        digest,
        subjectDigest: input.subjectDigest,
        token,
        question: input.question,
        context: `probe_authorization:v2:${digest}`,
        options: [
          { label: input.declineLabel, value: `decline_probe:v2:${digest}`, recommended: true },
          { label: input.confirmLabel, value: token, recommended: false },
        ],
        runId: input.runId,
        conversationId: input.conversationId,
        expiresAt: "2099-07-16T00:15:00.000Z",
      };
      return issued;
    }),
    restore: vi.fn(async (_domain, input) => issued && !consumed && input.id === issued.id ? issued : null),
    consume: vi.fn(async (_domain, input) => {
      if (!issued || consumed || input.challenge.id !== issued.id || input.answer !== issued.token) {
        throw new Error("challenge invalid or consumed");
      }
      consumed = true;
      return {
        challengeId: issued.id,
        kind: issued.kind,
        protocolVersion: issued.protocolVersion,
        digest: issued.digest,
        subjectDigest: issued.subjectDigest,
        authorizationDigest: "authorization-digest",
        actor: input.actor,
        runId: issued.runId,
        conversationId: issued.conversationId,
        consumedAt: "2026-07-16T00:01:00.000Z",
        expiresAt: issued.expiresAt,
      };
    }),
  };
  const ctx = {
    domain: "Agents-generation",
    conversationId: "run-fixture-1",
    emit: vi.fn(),
    realTools: [realTool],
    askedQuestions: {},
    ports: {
      tools: {
        list: async () => [],
        saveDraft: async () => ({
          revisionId: "tvr-signed-fixture-test",
          version: 1,
          definitionHash: "a".repeat(64),
          status: "draft" as const,
        }),
        prepareSignedFixture,
        createSignedFixture,
      },
      toolRegistry: { list: async () => [realTool] },
      authorizationChallenges,
    },
  } as unknown as BrainCtx;
  return { ctx, prepareSignedFixture, createSignedFixture, authorizationChallenges };
}

const request = {
  name: "vendor.lookup",
  exchanges: [{ args: { id: "candidate-1" }, status: 200, body: { ok: true } }],
  tool_config: { region: "cn" },
  ttl_hours: 24,
};

describe("create_signed_fixture human interaction", () => {
  it("parks on a server challenge and only persists after an exact authenticated answer", async () => {
    const { ctx, prepareSignedFixture, createSignedFixture, authorizationChallenges } = context();
    const parked = await signedFixtureTool.execute(request, ctx);
    expect(parked).toMatchObject({
      ok: true,
      output: {
        authorizationRequired: true,
        evidenceMode: "signed-fixture",
        sandboxOnly: true,
        promotionAllowed: false,
      },
    });
    expect(prepareSignedFixture).toHaveBeenCalledOnce();
    expect(createSignedFixture).not.toHaveBeenCalled();
    const challenge = Object.values(ctx.pendingAuthorizationChallenges ?? {})[0]!;
    expect(challenge.question).toContain("仅供 sandbox 回放");
    expect(challenge.question).toContain("不能用于 promotion");
    expect(challenge.options.find((option) => option.value === challenge.token)?.recommended).toBe(false);

    ctx.clarificationAnswerEvidence = {
      [normalizeQuestion(challenge.question)]: {
        question: challenge.question,
        context: challenge.context,
        options: challenge.options,
        answer: challenge.token,
        actor: "usr-reviewer",
        answeredAt: Date.now(),
      },
    };
    const created = await signedFixtureTool.execute({ ...request, confirmed: true }, ctx);
    expect(created.ok).toBe(true);
    expect(created.summary).toContain("promotion 仍会硬拒绝");
    expect(authorizationChallenges.consume).toHaveBeenCalledOnce();
    expect(createSignedFixture).toHaveBeenCalledWith(expect.objectContaining({
      expectedDefinitionHash: "a".repeat(64),
      expectedSubjectDigest: "c".repeat(64),
      authorization: expect.objectContaining({ actor: "usr-reviewer" }),
      execution: { runId: "run-fixture-1", conversationId: "run-fixture-1" },
    }));

    const replay = await signedFixtureTool.execute({ ...request, confirmed: true }, ctx);
    expect(replay.ok).toBe(false);
    expect(replay.summary).toContain("不能由模型自行填写");
    expect(createSignedFixture).toHaveBeenCalledOnce();
  });

  it("does not let confirmed=true authorize changed entries or a first call", async () => {
    const { ctx, createSignedFixture } = context();
    const first = await signedFixtureTool.execute({ ...request, confirmed: true }, ctx);
    expect(first.ok).toBe(false);
    expect(first.summary).toContain("不能由模型自行填写");

    await signedFixtureTool.execute(request, ctx);
    const changed = await signedFixtureTool.execute({
      ...request,
      exchanges: [{ args: { id: "candidate-1" }, status: 200, body: { ok: false } }],
      confirmed: true,
    }, ctx);
    expect(changed.ok).toBe(false);
    expect(changed.summary).toContain("完全一致");
    expect(createSignedFixture).not.toHaveBeenCalled();
  });

  it("rejects literal secrets before preparing or parking a challenge", async () => {
    const { ctx, prepareSignedFixture, authorizationChallenges } = context();
    const result = await signedFixtureTool.execute({
      ...request,
      exchanges: [{
        args: { id: "candidate-1" },
        status: 200,
        body: { ok: true, api_key: "sk-not-allowed-123456" },
      }],
    }, ctx);
    expect(result.ok).toBe(false);
    expect(result.summary).toContain("字面凭证");
    expect(prepareSignedFixture).not.toHaveBeenCalled();
    expect(authorizationChallenges.issue).not.toHaveBeenCalled();
  });

  it("drops an expired proposal and prepares a new exact subject instead of re-asking forever", async () => {
    const { ctx, prepareSignedFixture, authorizationChallenges } = context();
    await signedFixtureTool.execute(request, ctx);
    const parked = Object.values(ctx.pendingSignedFixtureProposals ?? {})[0]!;
    parked.preparation.expiresAt = "2000-01-01T00:00:00.000Z";
    prepareSignedFixture.mockResolvedValueOnce({
      ...parked.preparation,
      subjectDigest: "f".repeat(64),
      recordedAt: "2026-07-16T01:00:00.000Z",
      expiresAt: "2099-07-17T00:00:00.000Z",
    });

    const renewed = await signedFixtureTool.execute(request, ctx);
    expect(renewed.ok).toBe(true);
    expect(renewed.output).toMatchObject({ subjectDigest: "f".repeat(64) });
    expect(prepareSignedFixture).toHaveBeenCalledTimes(2);
    expect(authorizationChallenges.issue).toHaveBeenCalledTimes(2);
    expect(Object.values(ctx.pendingAuthorizationChallenges ?? {})).toHaveLength(1);
  });

  it("consumes once and requires a fresh review when durable persistence fails", async () => {
    const { ctx, createSignedFixture, authorizationChallenges } = context();
    createSignedFixture.mockRejectedValueOnce(new Error("database unavailable"));
    await signedFixtureTool.execute(request, ctx);
    const challenge = Object.values(ctx.pendingAuthorizationChallenges ?? {})[0]!;
    ctx.clarificationAnswerEvidence = {
      [normalizeQuestion(challenge.question)]: {
        question: challenge.question,
        context: challenge.context,
        options: challenge.options,
        answer: challenge.token,
        actor: "usr-reviewer",
        answeredAt: Date.now(),
      },
    };

    const failed = await signedFixtureTool.execute({ ...request, confirmed: true }, ctx);
    expect(failed.ok).toBe(false);
    expect(failed.summary).toContain("人工确认已一次性消费");
    expect(authorizationChallenges.consume).toHaveBeenCalledOnce();
    expect(createSignedFixture).toHaveBeenCalledOnce();
    expect(Object.keys(ctx.pendingSignedFixtureProposals ?? {})).toHaveLength(0);

    const replay = await signedFixtureTool.execute({ ...request, confirmed: true }, ctx);
    expect(replay.ok).toBe(false);
    expect(replay.summary).toContain("不能由模型自行填写");
    expect(createSignedFixture).toHaveBeenCalledOnce();
  });
});
