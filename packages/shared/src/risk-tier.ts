/**
 * #RISK-TIER — one declarative statement of what controls a call needs, derived
 * from what tools ALREADY declare, shared by both harness layers.
 *
 * This is a CONSOLIDATION, not a fourth opinion. Risk is already decided in
 * several places, and all of them key on the same two vocabularies:
 *
 *   manifest `tool_use[].side_effect` / catalog `sideEffect` : read | write | dual | call
 *   execution policy `operation`                             : read | compute | write | read_write
 *   execution policy `effectScope`                           : none | external | sandbox_local
 *   brain `BrainToolEffect.scope` (its own field name)       : conversation | factory_durable | external | sandbox | none
 *   brain `BrainToolEffect.checkpoint`                       : turn | immediate
 *
 * The brain's axes are NOT decoration. It calls an in-memory ctx edit a "write",
 * so `sideEffect` alone inverts its blast radius — `create_plan` reads as a
 * governed mutation while `sandbox_run`, which deploys a real billed sandbox,
 * reads as a plain call. `scope` and `checkpoint` are what separate them.
 *
 * So there is no new annotation to maintain: a tool that already declares its
 * policy triple is already tiered. The value is that "what must be true before
 * this runs" stops being spread across four call sites and becomes a value that
 * a gap report, a gate, or a UI can all quote.
 *
 * Deliberately NOT an enforcement point. It says what a call NEEDS; the existing
 * gates remain the things that enforce. Anything else would be the fourth
 * opinion this is meant to avoid.
 */

/** What must be satisfied before a call of this tier runs. */
export type RiskControl =
  | "straight_through"
  | "rule_check"
  | "probe_verified"
  | "human_signoff";

export type RiskTier = "read" | "write" | "external_write" | "production";

export interface RiskFacets {
  /** `read | write | dual | call` — manifest `side_effect` or catalog `sideEffect`. */
  sideEffect?: string | null;
  /** `read | compute | write | read_write` — reviewed execution policy. */
  operation?: string | null;
  /** Runtime scope: `none | external | sandbox_local`. */
  effectScope?: string | null;
  /**
   * The brain's own scope axis: `conversation | factory_durable | external |
   * sandbox | none`. It is a SEPARATE field because the brain names it `scope`,
   * and because its vocabulary is what distinguishes an in-memory ctx edit from
   * a durable artifact — a distinction `sideEffect` alone does not carry, since
   * the brain calls both of them "write".
   */
  scope?: string | null;
  /**
   * The brain's `checkpoint`. `"immediate"` is defined at its declaration site
   * as "a replay would duplicate an effect that is expensive, externally
   * visible, or creates a NEW durable row/artifact" — which is precisely a
   * statement of blast radius, so it is a tier input rather than decoration.
   */
  checkpoint?: string | null;
  /** Reserved: the sandbox policy is a dispatch decision, not a tier input. It
   * is accepted so callers can pass a whole policy triple unchanged. */
  sandboxPolicy?: string | null;
}

export interface RiskAssessment {
  tier: RiskTier;
  controls: RiskControl[];
  /** Human-readable justification, so a refusal or gap report can quote it
   * instead of restating the table. */
  reason: string;
  /**
   * True when the facets were too incomplete to decide. Callers must treat this
   * as "unknown blast radius", never as "harmless": the assessment already
   * returns the conservative controls, and this flag says the answer is a
   * fallback rather than a reading.
   */
  undetermined: boolean;
}

const MUTATING_SIDE_EFFECTS = new Set(["write", "dual"]);
const MUTATING_OPERATIONS = new Set(["write", "read_write"]);
const READ_SIDE_EFFECTS = new Set(["read"]);
const READ_OPERATIONS = new Set(["read", "compute"]);
const KNOWN_SCOPES = new Set([
  "none",
  "external",
  "sandbox_local",
  "conversation",
  "factory_durable",
  "production",
  // The brain deploys a real, billed ephemeral sandbox under this scope.
  "sandbox",
]);
/** Scopes whose effects never leave the process: an edit here is not a write in
 * any durable sense, however the declaring layer names its sideEffect. */
const IN_MEMORY_SCOPES = new Set(["conversation"]);
/** Scopes that produce a durable or externally visible effect. */
const DURABLE_SCOPES = new Set(["factory_durable", "production"]);
/** Scopes that reach beyond this system. */
const OUTBOUND_SCOPES = new Set(["external", "sandbox"]);

function known(value: string | null | undefined, vocab: Set<string>): boolean {
  return typeof value === "string" && vocab.has(value);
}

/**
 * Assess one call's risk from its declared facets.
 *
 * Each axis is read independently and the RISKIER reading wins: a reviewed
 * `operation: "read"` must not erase a declared `side_effect: "write"`, because
 * the two vocabularies describe different things and either may be the one
 * carrying the truth.
 */
export function assessRisk(facets: RiskFacets): RiskAssessment {
  const sideEffect = typeof facets.sideEffect === "string" ? facets.sideEffect : undefined;
  const operation = typeof facets.operation === "string" ? facets.operation : undefined;
  // One scope concept, two field names: the runtime says `effectScope`, the
  // brain says `scope`. Reading only the former is what made every brain tool
  // scope-less and inverted its tiering.
  const effectScope =
    (typeof facets.effectScope === "string" ? facets.effectScope : undefined) ??
    (typeof facets.scope === "string" ? facets.scope : undefined);
  const checkpoint = typeof facets.checkpoint === "string" ? facets.checkpoint : undefined;

  const recognised =
    known(sideEffect, MUTATING_SIDE_EFFECTS) ||
    known(sideEffect, READ_SIDE_EFFECTS) ||
    sideEffect === "call" ||
    known(operation, MUTATING_OPERATIONS) ||
    known(operation, READ_OPERATIONS) ||
    known(effectScope, KNOWN_SCOPES) ||
    checkpoint === "immediate";

  if (!recognised) {
    // Nothing decidable was declared. Return the conservative controls AND say
    // the answer is a fallback — a caller that treats this as a read is the
    // fail-open this table exists to prevent.
    return {
      tier: "external_write",
      controls: ["rule_check", "probe_verified", "human_signoff"],
      reason:
        "该调用没有声明任何可识别的影响面（side_effect / operation / effectScope）——未知的爆炸半径按最高管控处理，并标记为「未判定」",
      undetermined: true,
    };
  }

  const declaresMutation =
    known(sideEffect, MUTATING_SIDE_EFFECTS) || known(operation, MUTATING_OPERATIONS);
  const inMemoryOnly = known(effectScope, IN_MEMORY_SCOPES);
  // An in-memory scope OVERRIDES a declared write: the brain uses `write` for a
  // ctx edit, and treating that as a governed mutation would demand a rule check
  // for `create_plan` while letting a real sandbox deploy through as a read.
  const mutates =
    !inMemoryOnly &&
    (declaresMutation || known(effectScope, DURABLE_SCOPES) || checkpoint === "immediate");
  // `call` reaches a third party even when the scope field is silent; every
  // `call` tool in the live catalog is also `effectScope: "external"`.
  const reachesOutside =
    known(effectScope, OUTBOUND_SCOPES) || (sideEffect === "call" && !inMemoryOnly);
  const isProduction = effectScope === "production";

  const controls: RiskControl[] = [];
  let tier: RiskTier;
  const why: string[] = [];

  if (isProduction) {
    tier = "production";
    controls.push("human_signoff");
    why.push("effectScope=production（作用于生产面）");
  } else if (mutates && reachesOutside) {
    tier = "external_write";
    why.push("对外部系统产生写入");
  } else if (mutates) {
    tier = "write";
    why.push("会改变持久状态");
  } else {
    tier = "read";
    why.push("只读");
  }

  // A mutating call is what an ontology rule governs; a read is not.
  if (mutates || isProduction) {
    controls.push("rule_check");
    why.push("需要规则义务裁决");
  }
  // A probe attests an EXTERNAL integration — the same trigger the dispatch
  // probe check uses. A sandbox-local write has no remote integration to attest.
  if (reachesOutside) {
    controls.push("probe_verified");
    why.push("跨出系统边界，需要当前有效的探针证据");
  }
  if (controls.length === 0) {
    controls.push("straight_through");
    why.push("无附加管控");
  }

  return {
    tier,
    controls: [...new Set(controls)],
    reason: why.join("；"),
    undetermined: false,
  };
}

/**
 * Convenience for the gap reports: does a call at these facets need to be
 * covered by an ontology rule gate at all? A read does not; a mutating or
 * undeclared one does.
 */
export function requiresRuleGate(facets: RiskFacets): boolean {
  return assessRisk(facets).controls.includes("rule_check");
}
