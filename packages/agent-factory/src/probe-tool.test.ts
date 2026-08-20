import { describe, expect, it, vi } from "vitest";
import { FACTORY_TOOLS, normalizeQuestion } from "./tools";
import type { BrainCtx } from "./brain-types";
import {
  FACTORY_AUTHORIZATION_PROTOCOL_VERSION,
  type FactoryAuthorizationChallenge,
  type FactoryAuthorizationChallengeStore,
} from "./authorization-challenge";

const probeTool = FACTORY_TOOLS.find((tool) => tool.name === "probe_tool")!;

const writeProbeSafety = {
  testDataContract: {
    kind: "synthetic_canary" as const,
    marker: { kind: "argument" as const, path: "probe.marker", valuePrefix: "factory-canary-" },
  },
  idempotency: { kind: "argument" as const, path: "probe.idempotency_key", valuePrefix: "factory-idem-" },
  isolation: {
    namespace: { kind: "argument" as const, path: "probe.namespace", valuePrefix: "factory-ns-" },
    target: { kind: "argument" as const, path: "probe.target", valuePrefix: "factory-target-" },
  },
  cleanup: { kind: "handler" as const, handler: "vendor.lookup.cleanupCanary" },
  absenceProof: { kind: "handler" as const, handler: "vendor.lookup.readCanary" },
};

function context(sideEffect: "read" | "write") {
  const probe = vi.fn(async () => ({
    verified: true,
    classification: "verified",
    definitionHash: "a".repeat(64),
    schemaHash: "b".repeat(64),
    durationMs: 5,
  }));
  const executionPolicy = sideEffect === "read"
    ? { operation: "read" as const, effectScope: "external" as const, sandboxPolicy: "live_external" as const }
    : { operation: "write" as const, effectScope: "external" as const, sandboxPolicy: "requires_attempt_grant" as const };
  const real = {
    name: "vendor.lookup",
    sideEffect,
    ...executionPolicy,
    capabilities: [{ systems: ["Vendor"], kinds: ["external_api"], roles: [sideEffect === "read" ? "reads" : sideEffect === "write" ? "writes" : "calls"], operations: ["lookup"], probeRequired: true }],
    probeStatus: "required" as const,
    catalogDefinition: {
      name: "vendor.lookup",
      category: "vendor",
      sideEffect,
      ...executionPolicy,
      argsSchema: { id: { type: "string", required: true } },
      returnsSchema: { result: { type: "object", required: true } },
      configSchema: { region: { type: "string" } },
      probeSafety: sideEffect === "write" ? writeProbeSafety : undefined,
    },
  };
  let issued: FactoryAuthorizationChallenge | undefined;
  let consumed = false;
  const authorizationChallenges: FactoryAuthorizationChallengeStore = {
    issue: vi.fn(async (_domain, input) => {
      const digest = input.subjectDigest;
      const token = `authorize_probe:v2:${digest}`;
      const challenge: FactoryAuthorizationChallenge = {
        id: "challenge-probe-1",
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
        expiresAt: "2099-07-13T00:15:00.000Z",
      };
      issued = challenge;
      return challenge;
    }),
    restore: vi.fn(async (_domain, input) => issued && !consumed && issued.id === input.id ? issued : null),
    consume: vi.fn(async (_domain, input) => {
      if (!issued || input.challenge.id !== issued.id || consumed) throw new Error("challenge invalid or consumed");
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
        consumedAt: "2026-07-13T00:00:00.000Z",
        expiresAt: issued.expiresAt,
      };
    }),
  };
  const ctx = {
    domain: "test",
    conversationId: "conv-1",
    emit: () => {},
    realTools: [real],
    askedQuestions: {},
    ports: {
      tools: {
        probe,
        list: async () => [],
        saveDraft: async () => ({
          revisionId: "tvr-probe-test",
          version: 1,
          definitionHash: "a".repeat(64),
          status: "draft" as const,
        }),
      },
      toolRegistry: { list: async () => [{ ...real, probeStatus: "verified" as const }] },
      authorizationChallenges,
    },
  } as unknown as BrainCtx;
  return { ctx, probe, real, authorizationChallenges };
}

describe("probe_tool human authorization and secret posture", () => {
  it("probes explicit read tools without a side-effect authorization", async () => {
    const { ctx, probe } = context("read");
    const result = await probeTool.execute({ name: "vendor.lookup", args: { id: "r1" } }, ctx);
    expect(result.ok).toBe(true);
    expect(probe).toHaveBeenCalledOnce();
  });

  it("requires and consumes an exact one-shot ask_user authorization for a requires_attempt_grant tool", async () => {
    const { ctx, probe, authorizationChallenges } = context("write");
    const request = { name: "vendor.lookup", args: { id: "r1" }, tool_config: { region: "cn" } };
    const pending = await probeTool.execute(request, ctx);
    const authorization = pending.output as { definitionHash: string };
    const challenge = Object.values(ctx.pendingAuthorizationChallenges ?? {})[0]!;
    expect(pending.ok).toBe(true);
    expect(challenge.token).toMatch(/^authorize_probe:v2:[a-f0-9]{64}$/);
    expect(challenge.context).toMatch(/^probe_authorization:v2:[a-f0-9]{64}$/);
    expect(challenge.options.find((option) => option.value === challenge.token)?.recommended).toBe(false);
    expect(JSON.stringify(pending.output)).not.toContain(challenge.token);
    expect(authorization.definitionHash).toMatch(/^[a-f0-9]{64}$/);
    expect(probe).not.toHaveBeenCalled();

    ctx.clarificationAnswerEvidence = {
      [normalizeQuestion(challenge.question)]: {
        question: challenge.question,
        context: challenge.context,
        options: [...challenge.options].reverse(),
        answer: challenge.token,
        actor: "usr-responder",
        answeredAt: Date.now(),
      },
    };
    const tamperedEvidence = await probeTool.execute({ ...request, allow_side_effects: true }, ctx);
    expect(tamperedEvidence.ok).toBe(false);
    expect(tamperedEvidence.summary).toContain("问题、context、token");
    expect(authorizationChallenges.consume).not.toHaveBeenCalled();
    ctx.clarificationAnswerEvidence[normalizeQuestion(challenge.question)]!.options = challenge.options;
    const allowed = await probeTool.execute({ ...request, allow_side_effects: true }, ctx);
    expect(allowed.ok).toBe(true);
    expect(probe).toHaveBeenCalledOnce();
    expect(probe).toHaveBeenCalledWith(expect.objectContaining({
      expectedDefinitionHash: authorization.definitionHash,
      authorization: expect.objectContaining({ actor: "usr-responder" }),
      execution: { runId: "conv-1", conversationId: "conv-1" },
    }));

    const replayed = await probeTool.execute({ ...request, allow_side_effects: true }, ctx);
    expect(replayed.ok).toBe(false);
    expect(replayed.summary).toContain("使用过");
    expect(probe).toHaveBeenCalledOnce();
  });

  it("fails closed when the reviewed execution policy is missing", async () => {
    const { ctx, probe, real } = context("read");
    delete (real as Partial<typeof real>).operation;
    const result = await probeTool.execute({ name: "vendor.lookup", args: { id: "r1" } }, ctx);
    expect(result).toMatchObject({
      ok: false,
      output: { status: "needs_config", next: "ask_user", missing: ["tool_execution_policy"] },
    });
    expect(probe).not.toHaveBeenCalled();
  });

  it("does not authorize changed args or config with an earlier token", async () => {
    const { ctx, probe } = context("write");
    await probeTool.execute({
      name: "vendor.lookup",
      args: { id: "approved" },
      tool_config: { region: "cn" },
    }, ctx);
    const challenge = Object.values(ctx.pendingAuthorizationChallenges ?? {})[0]!;
    expect(challenge.token).toMatch(/^authorize_probe:v2:/);

    const changedArgs = await probeTool.execute({
      name: "vendor.lookup",
      args: { id: "tampered" },
      tool_config: { region: "cn" },
      allow_side_effects: true,
    }, ctx);
    expect(changedArgs.ok).toBe(false);
    expect(changedArgs.summary).toContain("完全一致");

    const changedConfig = await probeTool.execute({
      name: "vendor.lookup",
      args: { id: "approved" },
      tool_config: { region: "us" },
      allow_side_effects: true,
    }, ctx);
    expect(changedConfig.ok).toBe(false);
    expect(changedConfig.summary).toContain("完全一致");
    expect(probe).not.toHaveBeenCalled();
  });

  it("drops an expired pending capability and only reissues after a fresh non-confirming call", async () => {
    const { ctx, probe, authorizationChallenges } = context("write");
    const request = { name: "vendor.lookup", args: { id: "r1" }, tool_config: { region: "cn" } };
    await probeTool.execute(request, ctx);
    const stale = Object.values(ctx.pendingAuthorizationChallenges ?? {})[0]!;
    stale.expiresAt = "2000-01-01T00:00:00.000Z";

    const expiredConfirmation = await probeTool.execute({ ...request, allow_side_effects: true }, ctx);
    expect(expiredConfirmation.ok).toBe(false);
    expect(expiredConfirmation.summary).toContain("没有找到");
    expect(probe).not.toHaveBeenCalled();

    const reissued = await probeTool.execute(request, ctx);
    expect(reissued.ok).toBe(true);
    expect(authorizationChallenges.issue).toHaveBeenCalledTimes(2);
    expect(probe).not.toHaveBeenCalled();
  });

  it("returns needs_config before I/O when a write tool lacks the full canary cleanup contract", async () => {
    const { ctx, probe, real } = context("write");
    delete real.catalogDefinition.probeSafety;
    const result = await probeTool.execute({ name: "vendor.lookup", args: { id: "r1" } }, ctx);
    expect(result.ok).toBe(false);
    expect(result.output).toMatchObject({
      status: "needs_config",
      next: "ask_user",
      missing: expect.arrayContaining(["test_data_contract", "idempotency_key", "cleanup", "absence_readback"]),
    });
    expect(probe).not.toHaveBeenCalled();
  });

  it("rejects literal credentials in probe arguments and config", async () => {
    const { ctx, probe } = context("read");
    expect((await probeTool.execute({ name: "vendor.lookup", args: { api_key: "secret" } }, ctx)).ok).toBe(false);
    expect((await probeTool.execute({ name: "vendor.lookup", args: { payload: { authorization: "Bearer secret" } } }, ctx)).ok).toBe(false);
    expect((await probeTool.execute({ name: "vendor.lookup", args: {}, tool_config: { api_key: "secret" } }, ctx)).ok).toBe(false);
    expect(probe).not.toHaveBeenCalled();
  });
});
