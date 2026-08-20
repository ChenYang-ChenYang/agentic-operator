// #7 (difficulty routing) — the TIER VOCABULARY, kept in a dependency-free leaf.
//
// `model-router.ts` needs the transport (to know whether the central gateway is
// installed) and the live catalog; `stream-gateway.ts` needs to label a
// preference with the tier that produced it. Both therefore depend on this
// module and not on each other, which keeps the dependency direction acyclic.
//
// Nothing here names a final model id: a tier is a preference expressed as
// ordered patterns over whatever a deployment's gateway actually serves, and
// every tier is overridable from configuration.

// Tiers, cheapest → strongest. `review` is the CRITIC tier (AI quality-judge / failure-diagnosis /
// post-run analysis) — the roles where a wrong verdict is most expensive, so they get the best
// model even though routine codegen stays on the `hard` main (质量优先·混合: strong-but-not-opus-
// every-turn). tierForContext never auto-routes to `review`; only explicit critic callers ask for it.
export type ModelTier = "fast" | "default" | "hard" | "review";

export const MODEL_TIERS: readonly ModelTier[] = [
  "fast",
  "default",
  "hard",
  "review",
] as const;

/** Built-in preference patterns used to DERIVE a tier chain from the live catalog when no env
 *  chain is pinned. Overridable per tier via FACTORY_MODEL_<TIER>_PREFER (comma-separated
 *  substrings/regex). These are heuristics over whatever the gateway serves — never hardcoded ids. */
// New-api gpt-5.6 tiering by price/strength: luna ($1/$6)→fast, terra ($2.50/$15)→default,
// sol ($5/$30)→hard, sol-pro→review (strongest for the critic). Each is listed first so it LEADS
// its tier when served, with the prior cross-family models kept as fallbacks. Bare "gpt-5" stays a
// broad family catch-all. `.` in a pattern is a regex wildcard — harmless (matches the literal dot).
const DEFAULT_PREFER: Record<ModelTier, string[]> = {
  fast: ["gpt-5.6-luna", "flash", "haiku", "mini", "nano", "lite", "small"],
  default: ["gpt-5.6-terra", "gemini-3.1-pro", "gpt-5.4", "sonnet", "pro", "gpt-5"],
  hard: ["gpt-5.6-sol", "sonnet", "kimi", "gpt-5.4", "opus", "gpt-5", "deepseek-v4-pro", "reason"],
  review: ["gpt-5.6-sol-pro", "opus", "gpt-5.5", "gpt-5", "sonnet", "reason"],
};

export function preferPatterns(
  tier: ModelTier,
  env: Record<string, string | undefined>,
): string[] {
  const raw = env[`FACTORY_MODEL_${tier.toUpperCase()}_PREFER`];
  const custom = (raw ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return custom.length ? custom : DEFAULT_PREFER[tier];
}

/** The tier's PINNED chain, straight from config (empty when the tier is unpinned). */
export function pinnedChain(
  tier: ModelTier,
  env: Record<string, string | undefined>,
): string[] {
  const raw =
    tier === "hard" ? env.FACTORY_MODEL_HARD
    : tier === "fast" ? env.FACTORY_MODEL_FAST
    : tier === "review" ? (env.FACTORY_MODEL_REVIEW ?? env.FACTORY_MODEL_HARD) // review falls back to hard's chain if unpinned
    : env.FACTORY_MODEL_DEFAULT;
  return (raw ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}

/**
 * The tier's ordered PREFERENCE — what this difficulty would like to run on,
 * strongest wish first. Config-driven throughout: a pinned `FACTORY_MODEL_<TIER>`
 * chain when one exists, else the tier's preference patterns.
 *
 * A preference is NOT an authorization. Under the API-hosted central gateway
 * these entries are matched against the routes the tenant/workspace already
 * allows: they can re-rank that set, never widen it. The base `FACTORY_AI_MODEL`
 * is deliberately excluded — appending a process-wide model id here is exactly
 * how environment config would override tenant policy.
 */
export function modelPreference(
  tier: ModelTier,
  env: Record<string, string | undefined> = process.env,
): string[] {
  const pinned = pinnedChain(tier, env);
  return pinned.length ? pinned : preferPatterns(tier, env);
}

/**
 * Which tier produced this preference sequence, for telemetry. `modelChain` is
 * the only producer, so this is a lookup of our own output rather than a guess;
 * a reordered/synthesized list (e.g. the heterogeneous review rotation) honestly
 * reports no tier instead of claiming one.
 */
export function tierForPreference(
  models: readonly string[],
  env: Record<string, string | undefined> = process.env,
): ModelTier | null {
  if (!models.length) return null;
  for (const tier of MODEL_TIERS) {
    const preference = modelPreference(tier, env);
    if (
      preference.length === models.length &&
      preference.every((entry, index) => entry === models[index])
    ) {
      return tier;
    }
  }
  return null;
}
