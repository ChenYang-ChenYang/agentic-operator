import type { FactoryScopeRecommendation } from "@agentic/agent-factory";

export interface IssuedFactoryScopeRecommendation {
  tenantId: string;
  domain: string;
  scenario: string;
  recommendationId: string;
  ontologyHash: string;
  mode: FactoryScopeRecommendation["mode"];
  actionIds: string[];
  issuedAt: number;
  expiresAt: number;
}

const receipts = new Map<string, IssuedFactoryScopeRecommendation>();
const DEFAULT_TTL_MS = 30 * 60_000;
const MAX_RECEIPTS = 2_000;

const normalizedScenario = (value: string): string =>
  value.normalize("NFKC").trim().replace(/\s+/g, " ");

const keyFor = (tenantId: string, recommendationId: string): string =>
  `${tenantId}\0${recommendationId}`;

function ttlMs(): number {
  const configured = Number(process.env.FACTORY_SCOPE_RECOMMENDATION_TTL_MS);
  return Number.isFinite(configured) && configured >= 60_000
    ? Math.min(configured, 24 * 60 * 60_000)
    : DEFAULT_TTL_MS;
}

function prune(now: number): void {
  for (const [key, receipt] of receipts) {
    if (receipt.expiresAt <= now) receipts.delete(key);
  }
  if (receipts.size <= MAX_RECEIPTS) return;
  const overflow = [...receipts.entries()]
    .sort((a, b) => a[1].issuedAt - b[1].issuedAt)
    .slice(0, receipts.size - MAX_RECEIPTS);
  for (const [key] of overflow) receipts.delete(key);
}

/** Record that this process actually issued an AI-backed recommendation. The
 * public deterministic id remains useful for idempotence, while this
 * tenant-scoped TTL receipt prevents a client from skipping the Q&A call and
 * fabricating the hash/id pair locally. A restart intentionally invalidates
 * outstanding recommendations and asks the FDE to analyze again. */
export function issueFactoryScopeRecommendation(input: {
  tenantId: string;
  domain: string;
  recommendation: FactoryScopeRecommendation;
  now?: number;
}): IssuedFactoryScopeRecommendation {
  const now = input.now ?? Date.now();
  prune(now);
  const receipt: IssuedFactoryScopeRecommendation = {
    tenantId: input.tenantId,
    domain: input.domain,
    scenario: normalizedScenario(input.recommendation.scenario),
    recommendationId: input.recommendation.recommendationId,
    ontologyHash: input.recommendation.ontologyHash,
    mode: input.recommendation.mode,
    actionIds: [...input.recommendation.actionIds],
    issuedAt: now,
    expiresAt: now + ttlMs(),
  };
  receipts.set(keyFor(receipt.tenantId, receipt.recommendationId), receipt);
  prune(now);
  return receipt;
}

export function getIssuedFactoryScopeRecommendation(input: {
  tenantId: string;
  domain: string;
  scenario: string;
  recommendationId: string;
  ontologyHash: string;
  now?: number;
}): IssuedFactoryScopeRecommendation | null {
  const now = input.now ?? Date.now();
  prune(now);
  const receipt = receipts.get(
    keyFor(input.tenantId, input.recommendationId),
  );
  if (
    !receipt ||
    receipt.expiresAt <= now ||
    receipt.domain !== input.domain ||
    receipt.ontologyHash !== input.ontologyHash ||
    receipt.scenario !== normalizedScenario(input.scenario)
  ) {
    return null;
  }
  return {
    ...receipt,
    actionIds: [...receipt.actionIds],
  };
}

/** Test isolation only; production never clears issued receipts selectively. */
export function clearFactoryScopeRecommendationReceiptsForTests(): void {
  receipts.clear();
}
