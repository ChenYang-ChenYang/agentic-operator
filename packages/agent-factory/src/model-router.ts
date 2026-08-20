// #7 — task-difficulty model routing with fallback chains. Config-driven, NO hardcoded final
// model ids: each tier reads a comma-separated env chain (first = preferred, rest = fallbacks),
// validated against the gateway's LIVE catalog (model-catalog.ts), and everything falls back to
// the base FACTORY model so the product runs out-of-the-box and any deployment can tune per tier
// without a code change.
//
//   FACTORY_MODEL_FAST=openai/gpt-5.6-luna,google/gemini-3-flash-preview,anthropic/claude-haiku-4.5   # reading / planning
//   FACTORY_MODEL_DEFAULT=openai/gpt-5.6-terra,google/gemini-3.1-pro-preview-customtools              # design
//   FACTORY_MODEL_HARD=openai/gpt-5.6-sol,anthropic/claude-sonnet-4.6                                 # code / refine / review
//
// When a tier's env chain is UNSET, the chain is DERIVED from the live catalog by preference
// patterns (also env-overridable), so a fresh deployment routes by difficulty without any config.
// streamTurn tries the chain in order, falling through on a model the gateway doesn't serve, and
// reports which model actually served the turn so the activity log can annotate it.

import {
  hasFactoryModelAdapter,
  resolveFactoryGateway,
} from "./stream-gateway";
import { cachedModelIds } from "./model-catalog";
import {
  MODEL_TIERS,
  modelPreference,
  pinnedChain,
  preferPatterns,
  tierForPreference,
  type ModelTier,
} from "./model-tiers";

// The tier vocabulary itself lives in the dependency-free `model-tiers` leaf so
// both this router and the transport can label a preference without importing
// each other. Re-exported here because this module is the router's public face.
export {
  MODEL_TIERS,
  modelPreference,
  preferPatterns,
  tierForPreference,
  type ModelTier,
};

/** Models that are clearly not chat/reasoning models — excluded from catalog derivation. */
const NON_CHAT = /image|embed|tts|audio|whisper|rerank|moderation|vision-ocr|speech/i;

/** Derive an ordered chain for a tier from the live catalog by preference patterns. */
function deriveFromCatalog(tier: ModelTier, catalog: string[], env: Record<string, string | undefined>): string[] {
  const chat = catalog.filter((id) => !NON_CHAT.test(id));
  const ranked: string[] = [];
  for (const pat of preferPatterns(tier, env)) {
    const re = new RegExp(pat, "i");
    for (const id of chat) if (re.test(id) && !ranked.includes(id)) ranked.push(id);
  }
  return ranked.slice(0, 3);
}

/** The ordered model chain for a tier — preferred first, then fallbacks, always ending in the
 *  base factory model (deduped) so there is always at least one model to try. */
export function modelChain(tier: ModelTier, env: Record<string, string | undefined> = process.env): string[] {
  // The API-hosted central gateway owns provider/model SELECTION: it alone
  // knows which routes this tenant enabled. The factory still states the task
  // DIFFICULTY it needs, as a preference the gateway intersects with that
  // allowed set — so tiering survives without process-wide FACTORY_MODEL_*
  // values ever overriding tenant/Vault policy.
  if (hasFactoryModelAdapter()) return modelPreference(tier, env);
  const base = resolveFactoryGateway(env).model;
  let chain = pinnedChain(tier, env);

  const catalog = cachedModelIds(env);
  // No env chain pinned → derive from the live catalog (config-driven defaults, no hardcoded ids).
  if (!chain.length && catalog && catalog.length) chain = deriveFromCatalog(tier, catalog, env);
  // Validate a pinned chain against the live catalog: drop ids the gateway doesn't serve so a
  // typo/decommissioned id doesn't burn a fallback attempt. Null-safe (skip when catalog unknown);
  // never let validation empty the chain (a partial catalog shouldn't strand a real id).
  if (catalog && catalog.length) {
    const served = chain.filter((m) => catalog.includes(m));
    if (served.length) chain = served;
  }

  const out = [...chain, base].filter((m, i, a) => m && a.indexOf(m) === i);
  return out.length ? out : [base];
}

/** #HETERO-REVIEW (P1-3, arXiv 2502.08788) — the review/critic chain must LEAD with a model whose
 *  BASE differs from the generator's head: same-model self-debate ≈ self-consistency but pricier
 *  (MAD never beat CoT >20% of configs), while heterogeneous judging adds +6.4~8.2% — the gain
 *  comes from complementary error distributions, and a CHEAPER different-family critic often beats
 *  a bigger same-family one. Pure reorder: if the review chain's head shares the generator head's
 *  model family, rotate the first different-family model to the front. Family = the id's last
 *  path segment's alpha prefix (e.g. "anthropic/claude-sonnet-4.6" → "claude"). */
export function modelFamily(id: string): string {
  const tail = id.includes("/") ? id.slice(id.lastIndexOf("/") + 1) : id;
  const m = tail.toLowerCase().match(/^[a-z]+/);
  return m ? m[0] : tail.toLowerCase();
}
export function heterogeneousReviewChain(
  generatorTier: ModelTier = "hard",
  env: Record<string, string | undefined> = process.env,
): string[] {
  const review = modelChain("review", env);
  const genHead = modelChain(generatorTier, env)[0];
  if (!genHead || review.length < 2) return review;
  if (modelFamily(review[0]!) !== modelFamily(genHead)) return review;
  const idx = review.findIndex((m) => modelFamily(m) !== modelFamily(genHead));
  if (idx <= 0) return review; // no different family available — keep order (still works, just homogeneous)
  return [review[idx]!, ...review.slice(0, idx), ...review.slice(idx + 1)];
}

/** Pick a tier from the brain's live PHASE so the per-turn driver model tracks task difficulty
 *  instead of being pinned to one model. The old version was a ONE-WAY RATCHET — `specs.length > 0
 *  → "hard"` meant that once the FIRST agent was designed, EVERY remaining turn (validate, sandbox,
 *  finish, small refines) stayed "hard" and so always served the hard chain's first model
 *  (sonnet-4.6). Now: reading → fast, planning → default, actively DESIGNING the planned agents →
 *  hard (each agent's prompt/logic is the heavy reasoning), and once the planned set is designed the
 *  lighter remaining work drops back to default. Heavy critic work (review/codegen/diagnosis) already
 *  routes to its own tier inside the tools, so this only sets the conductor's per-turn budget. */
export function tierForContext(ctx: { specs: { length: number }; currentPlan: Record<string, unknown> | null; policy?: { tierBias?: "fast" | null } }): ModelTier {
  // #POLICY — 前置路由的降档偏置：纯答疑/分析类请求（pipeline=analyze）全程 fast，省钱且够用。
  // 只允许向下偏置（fast）；向上加码仍由相位逻辑与各工具自己的 critic tier 决定，防止成本失控。
  if (ctx.policy?.tierBias === "fast") return "fast";
  if (!ctx.currentPlan && ctx.specs.length === 0) return "fast"; // reading the ontology
  if (ctx.specs.length === 0) return "default"; // a plan exists, about to design
  const planned = Array.isArray(ctx.currentPlan?.agents) ? (ctx.currentPlan!.agents as unknown[]).length : 0;
  return planned > 0 && ctx.specs.length < planned ? "hard" : "default"; // hard WHILE designing, else default
}
