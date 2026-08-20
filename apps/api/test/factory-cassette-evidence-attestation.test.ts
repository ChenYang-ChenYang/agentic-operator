import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import {
  factoryAuthorizationChallenges,
  getDb,
  tenants,
} from "@agentic/db";
import { makeToolCassetteEntry } from "@agentic/shared/cassette";

import {
  attestLiveProbeCassette,
  cassetteConfigHash,
  createAuthorizedSandboxEvidencePlanCassette,
  createAuthorizedSignedFixtureCassette,
  signedFixtureAuthorizationSubject,
  verifyCassetteEvidenceAttestation,
} from "../src/services/agent-factory/cassette-evidence-attestation";
import { DrizzleFactoryAuthorizationChallengeStore } from "../src/services/agent-factory/authorization-challenge-store";

const suffix = randomUUID();
const tenantId = `ten-cassette-attestation-${suffix}`;
const tenantSlug = `cassette-attestation-${suffix}`;
const domainId = `domain-cassette-attestation-${suffix}`;
const toolName = "vendor.lookup";
const definitionHash = "d".repeat(64);
const config = { base_url_env: "VENDOR_SANDBOX_URL", region: "cn" };
const key = Buffer.alloc(32, 7);
const now = new Date("2026-07-16T08:00:00.000Z");

function entry() {
  return makeToolCassetteEntry({
    toolName,
    args: { id: "candidate-1" },
    status: 200,
    body: { ok: true },
    recordedAt: now.toISOString(),
  });
}

function liveDocument() {
  return {
    version: 1 as const,
    tool: { name: toolName, definitionHash },
    evidence: {
      recordedAt: now.toISOString(),
      recordedBy: "system-placeholder",
      mode: "live-probe" as const,
    },
    entries: [entry()],
  };
}

const expected = {
  tenantId,
  tenantSlug,
  domainId,
  toolName,
  definitionHash,
  configHash: cassetteConfigHash(config),
  allowedModes: ["live-probe"] as const,
};

describe("factory cassette evidence attestation", () => {
  beforeAll(() => {
    getDb().insert(tenants).values({
      id: tenantId,
      slug: tenantSlug,
      name: "Cassette attestation test",
    }).run();
  });

  afterAll(() => {
    getDb().delete(factoryAuthorizationChallenges)
      .where(eq(factoryAuthorizationChallenges.tenantId, tenantId)).run();
    getDb().delete(tenants).where(eq(tenants.id, tenantId)).run();
  });

  it("binds exact tenant/domain/tool/definition/config/actor/mode/expiry and rejects tampering", () => {
    const signed = attestLiveProbeCassette(liveDocument(), {
      tenantId,
      tenantSlug,
      domainId,
      toolName,
      definitionHash,
      config,
      actor: "usr-prober",
    }, { key, now });

    expect(verifyCassetteEvidenceAttestation(signed, expected, { key, now }))
      .toMatchObject({ valid: true, summary: { mode: "live-probe", configHash: expected.configHash } });
    expect(verifyCassetteEvidenceAttestation(
      { ...signed, entries: [{ ...signed.entries[0]!, response: { status: 200, body: { ok: false } } }] },
      expected,
      { key, now },
    ).issues).toContain("cassette evidence signature is invalid");
    expect(verifyCassetteEvidenceAttestation(
      { ...signed, evidence: { ...signed.evidence!, mode: "signed-fixture" } },
      { ...expected, allowedModes: ["signed-fixture"] },
      { key, now },
    ).issues).toContain("cassette evidence mode binding mismatch");
    expect(verifyCassetteEvidenceAttestation(
      signed,
      { ...expected, tenantId: "another-tenant" },
      { key, now },
    ).valid).toBe(false);
    expect(verifyCassetteEvidenceAttestation(
      signed,
      { ...expected, configHash: cassetteConfigHash({ region: "us" }) },
      { key, now },
    ).valid).toBe(false);
    expect(verifyCassetteEvidenceAttestation(
      signed,
      expected,
      { key, now: new Date("2026-07-24T08:00:00.000Z") },
    ).issues).toContain("cassette evidence attestation has expired");
  });

  it("signs the transport JSON shape when optional in-memory fields are undefined", () => {
    const document = liveDocument();
    document.entries = [makeToolCassetteEntry({
      toolName,
      args: { id: "candidate-with-optional-fields" },
      status: 200,
      body: { ok: true },
    })];
    const signed = attestLiveProbeCassette(document, {
      tenantId,
      tenantSlug,
      domainId,
      toolName,
      definitionHash,
      config,
      actor: "usr-prober",
    }, { key, now });
    const persisted = JSON.parse(JSON.stringify(signed));
    expect(verifyCassetteEvidenceAttestation(persisted, expected, { key, now }))
      .toMatchObject({ valid: true });
  });

  it("mints signed-fixture only from an exact consumed human authorization", async () => {
    const recordedAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
    const fixtureInput = {
      tenantId,
      tenantSlug,
      domainId,
      toolName,
      definitionHash,
      config,
      entries: [entry()],
      recordedAt,
      expiresAt,
    };
    const subjectDigest = signedFixtureAuthorizationSubject(fixtureInput);
    const execution = { runId: `run-${suffix}`, conversationId: `run-${suffix}` };
    const store = new DrizzleFactoryAuthorizationChallengeStore(tenantId, domainId);
    const challenge = await store.issue(domainId, {
      kind: "probe",
      subjectDigest,
      ...execution,
      question: "是否签发这一个精确 fixture？",
      declineLabel: "不签发",
      confirmLabel: "签发一次",
    });
    const authorization = await store.consume(domainId, {
      challenge,
      answer: challenge.token,
      actor: "usr-fixture-reviewer",
      question: challenge.question,
      context: challenge.context,
      options: challenge.options,
    });
    const signed = createAuthorizedSignedFixtureCassette({
      ...fixtureInput,
      authorization,
      execution,
    }, { key });
    expect(signed.evidence?.mode).toBe("signed-fixture");
    expect(verifyCassetteEvidenceAttestation(signed, {
      ...expected,
      allowedModes: ["signed-fixture"],
    }, { key })).toMatchObject({ valid: true });

    expect(() => createAuthorizedSignedFixtureCassette({
      ...fixtureInput,
      entries: [
        makeToolCassetteEntry({
          toolName,
          args: { id: "different" },
          status: 200,
          body: { ok: true },
        }),
      ],
      authorization,
      execution,
    }, { key })).toThrow(/exact consumed human authorization/);
  });

  it("mints plan cassettes only for the exact kind, subject, run and conversation", async () => {
    const recordedAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
    const planSubjectDigest = "9".repeat(64);
    const execution = { runId: `run-plan-${suffix}`, conversationId: `conversation-plan-${suffix}` };
    const store = new DrizzleFactoryAuthorizationChallengeStore(tenantId, domainId);
    const challenge = await store.issue(domainId, {
      kind: "sandbox_evidence_plan",
      subjectDigest: planSubjectDigest,
      ...execution,
      question: "是否确认这份精确 sandbox evidence plan？",
      declineLabel: "不确认",
      confirmLabel: "仅确认一次",
    });
    const authorization = await store.consume(domainId, {
      challenge,
      answer: challenge.token,
      actor: "usr-plan-reviewer",
      question: challenge.question,
      context: challenge.context,
      options: challenge.options,
    });
    const input = {
      tenantId,
      tenantSlug,
      domainId,
      toolName,
      definitionHash,
      config,
      entries: [entry()],
      recordedAt,
      expiresAt,
      authorization,
      execution,
      planSubjectDigest,
    };
    const signed = createAuthorizedSandboxEvidencePlanCassette(input, { key });
    expect(signed.evidence).toMatchObject({
      mode: "signed-fixture",
      authorization: {
        kind: "sandbox_evidence_plan",
        subjectDigest: planSubjectDigest,
        challengeId: challenge.id,
      },
    });
    expect(verifyCassetteEvidenceAttestation(signed, {
      ...expected,
      allowedModes: ["signed-fixture"],
    }, { key })).toMatchObject({ valid: true });
    expect(() => createAuthorizedSandboxEvidencePlanCassette({
      ...input,
      planSubjectDigest: "8".repeat(64),
    }, { key })).toThrow(/exact consumed human authorization/);
    expect(() => createAuthorizedSandboxEvidencePlanCassette({
      ...input,
      execution: { ...execution, conversationId: "other-conversation" },
    }, { key })).toThrow(/current execution/);
    expect(() => createAuthorizedSignedFixtureCassette({
      ...input,
    }, { key })).toThrow(/exact consumed human authorization/);
  });

  it("never creates a trust root while verifying and supports independently signed export replay", async () => {
    const signingRoot = await mkdtemp(path.join(os.tmpdir(), "cassette-signing-root-"));
    const ciRoot = await mkdtemp(path.join(os.tmpdir(), "cassette-ci-root-"));
    try {
      const signed = attestLiveProbeCassette(liveDocument(), {
        tenantId,
        tenantSlug,
        domainId,
        toolName,
        definitionHash,
        config,
        actor: "usr-prober",
      }, { dataRoot: signingRoot });
      expect(() => verifyCassetteEvidenceAttestation(
        signed,
        expected,
        { dataRoot: ciRoot },
      )).toThrow(/trust root is unavailable/);
      await expect(
        import("node:fs/promises").then(({ access }) =>
          access(path.join(ciRoot, "factory-keys", "cassette-attestation.key"))),
      ).rejects.toThrow();
      expect(verifyCassetteEvidenceAttestation(
        signed,
        expected,
        { dataRoot: ciRoot, trust: "verified-regression-export" },
      )).toMatchObject({ valid: true });
    } finally {
      await rm(signingRoot, { recursive: true, force: true });
      await rm(ciRoot, { recursive: true, force: true });
    }
  });
});
