import { createHash, randomUUID } from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import {
  factoryAuthorizationChallenges,
  getDb,
} from "@agentic/db";
import {
  FACTORY_AUTHORIZATION_PROTOCOL_VERSION,
  INTEGRATION_PROFILE_AUTHORIZATION_CONTEXT_PREFIX,
  INTEGRATION_PROFILE_AUTHORIZATION_DECLINE_PREFIX,
  INTEGRATION_PROFILE_AUTHORIZATION_PREFIX,
  INTEGRATION_PROFILE_AUTHORIZATION_PROTOCOL_VERSION,
  PROBE_AUTHORIZATION_PREFIX,
  SANDBOX_EVIDENCE_PLAN_AUTHORIZATION_CONTEXT_PREFIX,
  SANDBOX_EVIDENCE_PLAN_AUTHORIZATION_DECLINE_PREFIX,
  SANDBOX_EVIDENCE_PLAN_AUTHORIZATION_PREFIX,
  SANDBOX_EVIDENCE_PLAN_AUTHORIZATION_PROTOCOL_VERSION,
  SANDBOX_DESIGN_REVIEW_AUTHORIZATION_CONTEXT_PREFIX,
  SANDBOX_DESIGN_REVIEW_AUTHORIZATION_DECLINE_PREFIX,
  SANDBOX_DESIGN_REVIEW_AUTHORIZATION_PREFIX,
  SANDBOX_DESIGN_REVIEW_AUTHORIZATION_PROTOCOL_VERSION,
  type FactoryAuthorizationChallenge,
  type FactoryAuthorizationChallengeKind,
  type FactoryAuthorizationChallengeStore,
  type FactoryHumanAuthorizationReceipt,
} from "@agentic/agent-factory";
import { stableJson } from "@agentic/shared/cassette";

const DIGEST = /^[a-f0-9]{64}$/;
const CONFIRM_VALUE_MARKER = "$factory_confirm_token";
const DEFAULT_CHALLENGE_TTL_MS = 15 * 60_000;
const MIN_CHALLENGE_TTL_MS = 30_000;
const MAX_CHALLENGE_TTL_MS = 24 * 60 * 60_000;
const sha256 = (value: unknown): string =>
  createHash("sha256").update(stableJson(value)).digest("hex");

/** Configuration is strict: a malformed/unsafe TTL disables challenge issue
 * rather than silently widening or shortening the authorization window. */
export function factoryAuthorizationChallengeTtlMs(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env.FACTORY_AUTHORIZATION_CHALLENGE_TTL_MS?.trim();
  if (!raw) return DEFAULT_CHALLENGE_TTL_MS;
  if (!/^\d+$/.test(raw)) throw new Error("FACTORY_AUTHORIZATION_CHALLENGE_TTL_MS must be an integer");
  const ttl = Number(raw);
  if (!Number.isSafeInteger(ttl) || ttl < MIN_CHALLENGE_TTL_MS || ttl > MAX_CHALLENGE_TTL_MS) {
    throw new Error(`FACTORY_AUTHORIZATION_CHALLENGE_TTL_MS must be between ${MIN_CHALLENGE_TTL_MS} and ${MAX_CHALLENGE_TTL_MS}`);
  }
  return ttl;
}

function tokenPrefix(kind: FactoryAuthorizationChallengeKind): string {
  if (kind === "probe") return PROBE_AUTHORIZATION_PREFIX;
  if (kind === "sandbox_evidence_plan") return SANDBOX_EVIDENCE_PLAN_AUTHORIZATION_PREFIX;
  if (kind === "sandbox_design_review") return SANDBOX_DESIGN_REVIEW_AUTHORIZATION_PREFIX;
  return INTEGRATION_PROFILE_AUTHORIZATION_PREFIX;
}

function protocolVersion(kind: FactoryAuthorizationChallengeKind): number {
  if (kind === "probe") return FACTORY_AUTHORIZATION_PROTOCOL_VERSION;
  if (kind === "sandbox_evidence_plan") return SANDBOX_EVIDENCE_PLAN_AUTHORIZATION_PROTOCOL_VERSION;
  if (kind === "sandbox_design_review") return SANDBOX_DESIGN_REVIEW_AUTHORIZATION_PROTOCOL_VERSION;
  return INTEGRATION_PROFILE_AUTHORIZATION_PROTOCOL_VERSION;
}

function contextPrefix(kind: FactoryAuthorizationChallengeKind): string {
  if (kind === "probe") return "probe_authorization:v2:";
  if (kind === "sandbox_evidence_plan") return SANDBOX_EVIDENCE_PLAN_AUTHORIZATION_CONTEXT_PREFIX;
  if (kind === "sandbox_design_review") return SANDBOX_DESIGN_REVIEW_AUTHORIZATION_CONTEXT_PREFIX;
  return INTEGRATION_PROFILE_AUTHORIZATION_CONTEXT_PREFIX;
}

function declinePrefix(kind: FactoryAuthorizationChallengeKind): string {
  if (kind === "probe") return "decline_probe:v2:";
  if (kind === "sandbox_evidence_plan") return SANDBOX_EVIDENCE_PLAN_AUTHORIZATION_DECLINE_PREFIX;
  if (kind === "sandbox_design_review") return SANDBOX_DESIGN_REVIEW_AUTHORIZATION_DECLINE_PREFIX;
  return INTEGRATION_PROFILE_AUTHORIZATION_DECLINE_PREFIX;
}

function requiredText(value: string, field: string, max = 2_000): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > max) throw new Error(`${field} is invalid`);
  return normalized;
}

function optionsForStorage(
  options: FactoryAuthorizationChallenge["options"],
  token: string,
): FactoryAuthorizationChallenge["options"] {
  return options.map((option) => ({
    ...option,
    value: option.value === token ? CONFIRM_VALUE_MARKER : option.value,
  }));
}

function optionsFromStorage(
  options: FactoryAuthorizationChallenge["options"],
  token: string,
): FactoryAuthorizationChallenge["options"] {
  return options.map((option) => ({
    ...option,
    value: option.value === CONFIRM_VALUE_MARKER ? token : option.value,
  }));
}

function rowAsChallenge(
  row: typeof factoryAuthorizationChallenges.$inferSelect,
): FactoryAuthorizationChallenge {
  const kind = row.kind as FactoryAuthorizationChallengeKind;
  const token = `${tokenPrefix(kind)}${row.digest}`;
  return {
    id: row.id,
    kind,
    protocolVersion: row.protocolVersion,
    digest: row.digest,
    subjectDigest: row.subjectDigest,
    token,
    question: row.question,
    context: row.context,
    options: optionsFromStorage(
      row.optionsJson as FactoryAuthorizationChallenge["options"],
      token,
    ),
    runId: row.runId,
    conversationId: row.conversationId,
    expiresAt: row.expiresAt.toISOString(),
  };
}

function authorizationDigest(input: {
  tenantId: string;
  domain: string;
  challenge: FactoryAuthorizationChallenge;
  actor: string;
}): string {
  return sha256({
    protocolVersion: input.challenge.protocolVersion,
    tenantId: input.tenantId,
    domain: input.domain,
    actor: input.actor,
    runId: input.challenge.runId,
    conversationId: input.challenge.conversationId,
    expiresAt: input.challenge.expiresAt,
    challengeDigest: input.challenge.digest,
    subjectDigest: input.challenge.subjectDigest,
  });
}

export class DrizzleFactoryAuthorizationChallengeStore implements FactoryAuthorizationChallengeStore {
  constructor(
    private readonly tenantId: string,
    private readonly expectedDomain: string,
  ) {}

  async issue(
    domain: string,
    input: {
      kind: FactoryAuthorizationChallengeKind;
      subjectDigest: string;
      runId: string;
      conversationId: string;
      question: string;
      declineLabel: string;
      confirmLabel: string;
    },
  ): Promise<FactoryAuthorizationChallenge> {
    if (domain !== this.expectedDomain) throw new Error("authorization challenge domain mismatch");
    if (!DIGEST.test(input.subjectDigest)) throw new Error("authorization challenge subject digest is invalid");
    const runId = requiredText(input.runId, "runId", 200);
    const conversationId = requiredText(input.conversationId, "conversationId", 200);
    const question = requiredText(input.question, "question");
    const declineLabel = requiredText(input.declineLabel, "declineLabel", 120);
    const confirmLabel = requiredText(input.confirmLabel, "confirmLabel", 120);
    const id = `fac-${randomUUID()}`;
    const expiresAt = new Date(Date.now() + factoryAuthorizationChallengeTtlMs());
    const challengeProtocolVersion = protocolVersion(input.kind);
    const digest = sha256({
      protocolVersion: challengeProtocolVersion,
      tenantId: this.tenantId,
      domain,
      actor: null,
      runId,
      conversationId,
      kind: input.kind,
      subjectDigest: input.subjectDigest,
      expiresAt: expiresAt.toISOString(),
      nonce: id,
    });
    const token = `${tokenPrefix(input.kind)}${digest}`;
    const context = `${contextPrefix(input.kind)}${digest}`;
    const options = [
      { label: declineLabel, value: `${declinePrefix(input.kind)}${digest}`, recommended: true },
      // Authorization is intentionally never the recommended branch.
      { label: confirmLabel, value: token, recommended: false },
    ];
    getDb().insert(factoryAuthorizationChallenges).values({
      id,
      tenantId: this.tenantId,
      domainKey: domain,
      kind: input.kind,
      protocolVersion: challengeProtocolVersion,
      digest,
      subjectDigest: input.subjectDigest,
      tokenDigest: sha256(token),
      question,
      context,
      // Persist only a marker for the confirmation capability. The digest is
      // enough to verify/reconstruct the canonical option; the raw token is
      // returned to the active conversation but not copied into this row.
      optionsJson: optionsForStorage(options, token),
      runId,
      conversationId,
      expiresAt,
    }).run();
    return {
      id,
      kind: input.kind,
      protocolVersion: challengeProtocolVersion,
      digest,
      subjectDigest: input.subjectDigest,
      token,
      question,
      context,
      options,
      runId,
      conversationId,
      expiresAt: expiresAt.toISOString(),
    };
  }

  async consume(
    domain: string,
    input: {
      challenge: FactoryAuthorizationChallenge;
      answer: string;
      actor: string;
      question: string;
      context: string;
      options: FactoryAuthorizationChallenge["options"];
    },
  ): Promise<FactoryHumanAuthorizationReceipt> {
    if (domain !== this.expectedDomain) throw new Error("authorization challenge domain mismatch");
    const actor = requiredText(input.actor, "authorization actor", 320);
    const challenge = input.challenge;
    if (
      challenge.protocolVersion !== protocolVersion(challenge.kind)
      || challenge.question !== input.question
      || challenge.context !== input.context
      || stableJson(challenge.options) !== stableJson(input.options)
      || challenge.token !== input.answer
      || challenge.options.some((option) => option.value === challenge.token && option.recommended)
    ) {
      throw new Error("authorization answer does not match the exact server challenge");
    }
    const consumedAt = new Date();
    getDb().transaction((tx) => {
      const row = tx.select().from(factoryAuthorizationChallenges).where(and(
        eq(factoryAuthorizationChallenges.id, challenge.id),
        eq(factoryAuthorizationChallenges.tenantId, this.tenantId),
        eq(factoryAuthorizationChallenges.domainKey, domain),
      )).all()[0];
      if (!row) throw new Error("authorization challenge does not exist in this tenant/domain");
      if (
        row.kind !== challenge.kind
        || row.protocolVersion !== challenge.protocolVersion
        || row.digest !== challenge.digest
        || row.subjectDigest !== challenge.subjectDigest
        || row.tokenDigest !== sha256(challenge.token)
        || row.question !== challenge.question
        || row.context !== challenge.context
        || row.runId !== challenge.runId
        || row.conversationId !== challenge.conversationId
        || row.expiresAt.toISOString() !== challenge.expiresAt
        || stableJson(row.optionsJson) !== stableJson(optionsForStorage(challenge.options, challenge.token))
      ) {
        throw new Error("authorization challenge storage identity mismatch");
      }
      if (row.expiresAt.getTime() <= consumedAt.getTime()) {
        throw new Error("authorization challenge expired; request a new server challenge");
      }
      const updated = tx.update(factoryAuthorizationChallenges).set({
        answeredBy: actor,
        answeredAt: consumedAt,
        consumedAt,
      }).where(and(
        eq(factoryAuthorizationChallenges.id, row.id),
        eq(factoryAuthorizationChallenges.tenantId, this.tenantId),
        eq(factoryAuthorizationChallenges.domainKey, domain),
        eq(factoryAuthorizationChallenges.digest, challenge.digest),
        eq(factoryAuthorizationChallenges.subjectDigest, challenge.subjectDigest),
        gt(factoryAuthorizationChallenges.expiresAt, consumedAt),
        isNull(factoryAuthorizationChallenges.consumedAt),
      )).run();
      if (updated.changes !== 1) throw new Error("authorization challenge was already consumed or expired");
    });
    return {
      challengeId: challenge.id,
      kind: challenge.kind,
      protocolVersion: challenge.protocolVersion,
      digest: challenge.digest,
      subjectDigest: challenge.subjectDigest,
      authorizationDigest: authorizationDigest({ tenantId: this.tenantId, domain, challenge, actor }),
      actor,
      runId: challenge.runId,
      conversationId: challenge.conversationId,
      consumedAt: consumedAt.toISOString(),
      expiresAt: challenge.expiresAt,
    };
  }

  async restore(
    domain: string,
    input: Pick<FactoryAuthorizationChallenge, "id" | "kind" | "protocolVersion" | "digest" | "subjectDigest" | "runId" | "conversationId" | "expiresAt">,
  ): Promise<FactoryAuthorizationChallenge | null> {
    if (domain !== this.expectedDomain) return null;
    const now = new Date();
    const row = getDb().select().from(factoryAuthorizationChallenges).where(and(
      eq(factoryAuthorizationChallenges.id, input.id),
      eq(factoryAuthorizationChallenges.tenantId, this.tenantId),
      eq(factoryAuthorizationChallenges.domainKey, domain),
      isNull(factoryAuthorizationChallenges.consumedAt),
      gt(factoryAuthorizationChallenges.expiresAt, now),
    )).all()[0];
    if (!row) return null;
    if (
      row.kind !== input.kind
      || row.protocolVersion !== protocolVersion(input.kind)
      || row.protocolVersion !== input.protocolVersion
      || row.digest !== input.digest
      || row.subjectDigest !== input.subjectDigest
      || row.runId !== input.runId
      || row.conversationId !== input.conversationId
      || row.expiresAt.toISOString() !== input.expiresAt
    ) return null;
    return rowAsChallenge(row);
  }
}

/** Re-check an opaque receipt at the final I/O boundary. This does not consume
 * again; it proves the provided receipt names the already-consumed DB row and
 * exact subject/actor scope. */
export function verifyConsumedFactoryAuthorization(input: {
  tenantId: string;
  domain: string;
  receipt: FactoryHumanAuthorizationReceipt;
  kind: FactoryAuthorizationChallengeKind;
  subjectDigest: string;
}): boolean {
  const { receipt } = input;
  if (
    receipt.kind !== input.kind
    || receipt.subjectDigest !== input.subjectDigest
    || receipt.protocolVersion !== protocolVersion(input.kind)
    || !receipt.actor.trim()
    || Date.parse(receipt.expiresAt) <= Date.now()
  ) return false;
  const row = getDb().select().from(factoryAuthorizationChallenges).where(and(
    eq(factoryAuthorizationChallenges.id, receipt.challengeId),
    eq(factoryAuthorizationChallenges.tenantId, input.tenantId),
    eq(factoryAuthorizationChallenges.domainKey, input.domain),
  )).all()[0];
  if (!row || !row.consumedAt || !row.answeredBy) return false;
  const challenge = rowAsChallenge(row);
  return row.kind === input.kind
    && row.protocolVersion === protocolVersion(input.kind)
    && row.protocolVersion === receipt.protocolVersion
    && row.subjectDigest === input.subjectDigest
    && row.digest === receipt.digest
    && row.answeredBy === receipt.actor
    && row.runId === receipt.runId
    && row.conversationId === receipt.conversationId
    && row.consumedAt.toISOString() === receipt.consumedAt
    && row.expiresAt.toISOString() === receipt.expiresAt
    && row.expiresAt.getTime() > Date.now()
    && authorizationDigest({
      tenantId: input.tenantId,
      domain: input.domain,
      challenge,
      actor: receipt.actor,
    }) === receipt.authorizationDigest;
}
