// Tool grounding for design_agent — ported from the OLD lib/tools/registry.ts
// (resolveToolName / suggestToolsForAction / groundToolPicks), but ONTOLOGY-DRIVEN
// for the new arch.
//
// The OLD repo grounded picks against a hand-coded ToolRegistry. The new monorepo has
// no such registry at design time; the source of truth for "what tools exist" is the
// domain ontology's `tool_use` (the real tool names each action declares) plus any
// names the brain itself introduces. So we build the catalog from the ontology and
// fuzzy-bind the brain's picks to it — de-hallucinating invented tool names — while
// staying robust when the catalog is empty (picks pass through as-is, marked).

import type { DomainOntology, OntologyAction } from "./ontology-types";
import type { GeneratedToolExecutionPolicy } from "./spec-types";

/** Every distinct tool name the domain's actions declare — the grounding catalog. */
export function buildToolCatalog(ontology: DomainOntology): string[] {
  const set = new Set<string>();
  for (const a of ontology.actions) for (const t of a.tool_use ?? []) if (t) set.add(t);
  return [...set].sort();
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");
// Split on non-alphanumerics AND camelCase boundaries, so "parseResume" → {parse, resume} and ranks
// against "parseResumeApi" → {parse, resume, api}. (#C — the action→real-tool match depends on this.)
const tokens = (s: string) => new Set(s.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));

/** Resolve a (possibly invented) tool name to a real catalog name. Exact match first,
 *  then normalized match, then a token-superset fuzzy bridge (e.g. "parseResumeFile"
 *  → "robohire.parseResume" when one name's tokens are a superset of the other's). */
export function resolveToolName(name: string, catalog: string[]): string | null {
  if (!name) return null;
  const exact = catalog.find((c) => c === name);
  if (exact) return exact;
  const n = norm(name);
  const normMatch = catalog.find((c) => norm(c) === n);
  if (normMatch) return normMatch;
  // token-superset fuzzy: the real name's tail tokens ⊆ the pick's tokens, or vice versa
  const picked = tokens(name);
  let best: { c: string; overlap: number } | null = null;
  for (const c of catalog) {
    const tail = c.includes(".") ? c.slice(c.indexOf(".") + 1) : c;
    const ct = tokens(tail);
    if (!ct.size) continue;
    const overlap = [...ct].filter((t) => picked.has(t)).length;
    // Require MORE than one shared token for the fuzzy bridge — else a lone generic token (read /
    // write / get / url / inbox) would silently rebind a placeholder pick onto an unrelated real
    // tool (exact/normalized matches above already handle legitimate single-token names).
    const subset = (overlap === ct.size || overlap === picked.size) && overlap > 1;
    if (subset && (!best || overlap > best.overlap)) best = { c, overlap };
  }
  return best?.c ?? null;
}

/** A real tool from the global registry (injected via the FactoryPorts.toolRegistry port so the
 *  pure factory package never imports @agentic/tools). configKeys = the per-tenant config the FDE
 *  must supply (e.g. api_key_env). */
export interface RealTool {
  name: string;
  summary?: string;
  aliases?: string[];
  configKeys?: string[];
  category?: string;
  sideEffect?: "read" | "write" | "dual" | "call";
  /** Reviewed execution policy. Optional at this port boundary only so stale
   * persisted adapters can be surfaced and repaired; selection fails closed
   * when any field is absent. */
  operation?: GeneratedToolExecutionPolicy["operation"];
  effectScope?: GeneratedToolExecutionPolicy["effectScope"];
  sandboxPolicy?: GeneratedToolExecutionPolicy["sandboxPolicy"];
  /** #KEY-GAP — global fallback env name(s) this tool REQUIRES for its credential (mirrors the
   *  catalog's `credentialEnv`). Empty/undefined = no required credential. Used by
   *  `detectMissingToolCredentials` so the brain can ask_user when a BOUND tool's key isn't set. */
  credentialEnv?: string[];
  /** #SCALE-TOOLS — empirical sandbox success rate (0..1) from tool_stats; undefined = no data yet. */
  successRate?: number;
  /** total sandbox invocations behind successRate (demotion needs >=3 to avoid noise). */
  invoked?: number;
  /** Explicit machine-readable integration coverage. Semantic similarity may
   * recommend a tool, but only these declarations can satisfy an Ontology
   * integration requirement. */
  capabilities?: ToolCapabilityDescriptor[];
  /** Latest live/schema probe status for the current tool definition. */
  probeStatus?: "verified" | "required" | "failed";
  /** Definition hash carried by the most recent successful probe. */
  definitionHash?: string;
  /** All definition/config hashes with currently valid probe receipts. A
   * single registry tool can be selected with more than one tenant config. */
  verifiedDefinitionHashes?: string[];
  /** Exact hashes whose receipt is an unexpired API-attested live probe.
   * This is the only hash set eligible to satisfy a production-stage gate. */
  productionVerifiedDefinitionHashes?: string[];
  /** Representative mode for display/diagnostics only. Exact stage gates use
   * the hash sets above and the corresponding receipt/cassette attestation. */
  probeEvidenceMode?: "live-probe" | "signed-fixture" | "runtime-record";
  /** Human-confirmed, tenant/domain-scoped non-secret configs. Values may name
   * server env vars but never contain the env values themselves. */
  integrationProfiles?: import("./integration-profile").IntegrationProfile[];
  /** Present for persisted declarative adapters so binding can prove that
   * probe evidence matches the exact definition + selected runtime config. */
  declarativeDefinition?: {
    name: string;
    method: string;
    urlTemplate: string;
    headers?: Record<string, string>;
    bodyTemplate?: string;
    sideEffect: string;
    operation?: GeneratedToolExecutionPolicy["operation"];
    effectScope?: GeneratedToolExecutionPolicy["effectScope"];
    sandboxPolicy?: GeneratedToolExecutionPolicy["sandboxPolicy"];
    requestSpec?: Record<string, unknown>;
    responseSpec?: Record<string, unknown>;
    examples?: Array<Record<string, unknown>>;
    paramsSchema?: Record<string, unknown>;
    returnsSchema?: Record<string, unknown>;
    capabilities?: ToolCapabilityDescriptor[];
    probeSafety?: import("@agentic/shared").WriteProbeSafetyContract;
  };
  /** Immutable registry metadata used to bind a global-tool probe receipt to
   * the exact adapter/schema/config selected by this spec. */
  catalogDefinition?: import("./declarative-tool-hash").CatalogToolDefinition;
}

export interface ToolCapabilityDescriptor {
  systems: string[];
  /** For systems:["*"], exact integration-profile config key containing the
   * concrete Ontology system identity. */
  systemConfigKey?: string;
  kinds: string[];
  roles: string[];
  operations?: string[];
  /** This capability is intentionally unusable when the Ontology omits an
   * exact operation coordinate. Useful for narrow graph/database SDK
   * surfaces that would otherwise look like an arbitrary instance reader. */
  requiresOperation?: boolean;
  objectTypes?: string[];
  /** External side effects commonly require a live or signed-fixture probe. */
  probeRequired?: boolean;
}

/** #KEY-GAP (flexible, non-hardcoded credential detection) — given the tool names a generated agent
 *  has BOUND and the real registry, report which bound tools declare a REQUIRED credential env
 *  (`credentialEnv`) that is NOT satisfied in `env`. Fully generic: it reads each tool's OWN
 *  self-declared `credentialEnv` and checks the environment — no tool name is ever special-cased. A
 *  credential is "satisfied" if ANY of its declared env names is present + non-empty. The factory
 *  feeds the result to the brain, which REASONS about it and may `ask_user` to recommend the operator
 *  configure the key — it is never auto-filled and never hardcoded. */
export interface MissingCredential { tool: string; missingEnv: string[]; }
export function detectMissingToolCredentials(
  boundToolNames: string[],
  realTools: RealTool[],
  env: Record<string, string | undefined> = process.env,
  toolConfigs: Record<string, Record<string, unknown>> = {},
): MissingCredential[] {
  const byName = new Map<string, RealTool>();
  for (const t of realTools) {
    byName.set(t.name, t);
    for (const a of t.aliases ?? []) if (!byName.has(a)) byName.set(a, t);
  }
  const seen = new Set<string>();
  const out: MissingCredential[] = [];
  for (const name of boundToolNames) {
    const rt = byName.get(name);
    const configuredEnvRefs: string[] = [];
    const collect = (value: unknown): void => {
      if (Array.isArray(value)) {
        value.forEach(collect);
        return;
      }
      if (!value || typeof value !== "object") return;
      for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
        if (/_env$/i.test(key) && typeof item === "string") configuredEnvRefs.push(item);
        collect(item);
      }
    };
    collect(toolConfigs[rt?.name ?? name] ?? {});
    const envs = [...new Set([...(rt?.credentialEnv ?? []), ...configuredEnvRefs])];
    if (!rt || !envs.length || seen.has(rt.name)) continue; // no required credential / already reported
    const satisfied = configuredEnvRefs.some((e) => (env[e] ?? "").trim() !== "") || (rt.credentialEnv ?? []).some((e) => (env[e] ?? "").trim() !== "");
    if (!satisfied) { out.push({ tool: rt.name, missingEnv: envs }); seen.add(rt.name); }
  }
  return out;
}

/** #C — semantic ranking (restored from old AO): score each REAL tool by token-overlap of the
 *  action's name + target_objects against the tool's name + summary (+3 action token in the NAME,
 *  +2 a target-object token in the name, +1 in the summary). Returns the top-N real tool NAMES — so
 *  an action that declares NO tools still gets a real recommendation (parseResume → parseResumeApi). */
export function rankRealTools(action: OntologyAction, realTools: RealTool[], limit = 4): string[] {
  if (!realTools.length) return [];
  const actToks = tokens(action.name);
  // #SCALE-TOOLS — EMPIRICAL DEMOTION: a tool that keeps failing in real sandbox runs (<70% success,
  // >=3 invocations) drops out of recommendations even if it matches semantically.
  const demoted = new Set(realTools.filter((t) => (t.invoked ?? 0) >= 3 && (t.successRate ?? 1) < 0.7).map((t) => t.name));
  const objToks = new Set((action.target_objects ?? []).flatMap((o) => [...tokens(String(o))]));
  // Tool need is often declared in execution metadata rather than in the action name. Fold
  // action_steps/integration/side_effects into semantic discovery so a generic action label does
  // not hide its declared storage and external-system boundaries. Recommendations stay
  // ontology-driven instead of growing per-domain name maps.
  const executionContext = [
    action.description ?? "",
    JSON.stringify(action.action_steps ?? []),
    JSON.stringify(action.integration ?? {}),
    JSON.stringify(action.side_effects ?? {}),
  ].join(" ");
  const contextToks = tokens(executionContext);
  const scored = realTools
    .filter((t) => !demoted.has(t.name))
    .map((t) => {
      const bare = t.name.includes(".") ? t.name.slice(t.name.indexOf(".") + 1) : t.name;
      const nameToks = new Set([...tokens(bare), ...(t.aliases ?? []).flatMap((a) => [...tokens(a)])]);
      const sumToks = tokens(t.summary ?? "");
      let score = 0;
      for (const tk of actToks) { if (nameToks.has(tk)) score += 3; else if (sumToks.has(tk)) score += 1; }
      for (const tk of objToks) { if (nameToks.has(tk)) score += 2; else if (sumToks.has(tk)) score += 1; }
      for (const tk of contextToks) { if (nameToks.has(tk)) score += 2; else if (sumToks.has(tk)) score += 1; }
      return { name: t.name, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
  return scored.map((x) => x.name);
}

/** The tools suggested for an action: the ontology's declared tool_use FIRST, then (when a real
 *  registry is available) the top semantically-ranked real tools. Restores action→real-tool mapping. */
export function suggestToolsForAction(action: OntologyAction, realTools: RealTool[] = []): string[] {
  return [...new Set([...(action.tool_use ?? []).filter(Boolean), ...rankRealTools(action, realTools)])];
}

// Authority never comes from a name/category regex. `parse`, `sync` and
// `match` are routinely either read-only or mutating depending on the real
// adapter; guessing here can silently bypass write-probe and approval gates.
export function toolSideEffect(
  tool: Pick<RealTool, "sideEffect">,
): "read" | "write" | "dual" | "call" | "unknown" {
  return tool.sideEffect ?? "unknown";
}

export interface ToolSearchHit { name: string; summary?: string; category?: string; configKeys: string[]; sideEffect: string; score: number; }

/** Progressive tool search: rank the REAL registry by a free-text intent (token overlap of the
 *  query against name+aliases+summary+category), optionally filtered by category / side-effect. Lets
 *  the brain DISCOVER tools per-action (渐进式披露) instead of being handed the whole catalog at once. */
export function searchRealTools(
  query: string,
  realTools: RealTool[],
  opts: { category?: string; sideEffect?: string; limit?: number } = {},
): ToolSearchHit[] {
  const qToks = tokens(query);
  const cat = opts.category?.toLowerCase();
  const filtering = !!cat || !!opts.sideEffect;
  return realTools
    .filter((t) => !cat || (t.category ?? "").toLowerCase() === cat)
    .filter((t) => !opts.sideEffect || toolSideEffect(t) === opts.sideEffect)
    .map((t) => {
      const bare = t.name.includes(".") ? t.name.slice(t.name.indexOf(".") + 1) : t.name;
      const nameToks = new Set([...tokens(bare), ...(t.aliases ?? []).flatMap((a) => [...tokens(a)])]);
      const sumToks = tokens(t.summary ?? "");
      const catToks = tokens(t.category ?? "");
      let score = 0;
      for (const tk of qToks) { if (nameToks.has(tk)) score += 3; else if (sumToks.has(tk)) score += 1; else if (catToks.has(tk)) score += 1; }
      return { name: t.name, summary: t.summary, category: t.category, configKeys: t.configKeys ?? [], sideEffect: toolSideEffect(t), score };
    })
    // when a category/side-effect filter is set, list even score-0 matches (browse mode);
    // otherwise require at least one shared token (a real semantic hit).
    .filter((x) => x.score > 0 || filtering)
    .sort((a, b) => b.score - a.score)
    .slice(0, opts.limit ?? 6);
}

export interface GroundResult {
  /** picks resolved to real catalog names (deduped, order-preserved) */
  resolved: string[];
  /** picks that were a non-real name bridged onto a real tool */
  bridged: Array<{ raw: string; resolved: string }>;
  /** picks that resolved to nothing in the catalog (kept as-is for human review) */
  unresolved: string[];
}

/** Ground the brain's tool picks against the catalog: resolve, bridge, or mark
 *  unresolved. When the catalog is empty (common for new-arch manifest domains whose
 *  tools live as code), picks pass through unresolved rather than being dropped. */
export function groundToolPicks(picks: string[], catalog: string[]): GroundResult {
  const resolved: string[] = [];
  const bridged: Array<{ raw: string; resolved: string }> = [];
  const unresolved: string[] = [];
  const seen = new Set<string>();
  for (const raw of picks) {
    if (!raw) continue;
    const hit = catalog.length ? resolveToolName(raw, catalog) : null;
    if (hit) {
      if (hit !== raw) bridged.push({ raw, resolved: hit });
      if (!seen.has(hit)) {
        seen.add(hit);
        resolved.push(hit);
      }
    } else {
      // no catalog (or no match): keep the brain's name so the agent still binds it,
      // but flag it for human review (the new arch resolves tools at deploy time).
      if (!seen.has(raw)) {
        seen.add(raw);
        resolved.push(raw);
      }
      unresolved.push(raw);
    }
  }
  return { resolved, bridged, unresolved };
}

const EVENT_TOKEN_ALLOW = new Set(["SYSTEM_PROMPT", "JSON", "TODO", "FIXME", "HTTP", "HTTPS", "API", "URL", "URI", "UUID", "SQL", "CSV", "PDF", "AI"]);

/** ALL_CAPS_UNDERSCORE tokens in free text that aren't in the ontology's events — the
 *  brain's hallucination vector (RESUME_PARSED vs the real RESUME_PROCESSED). Warning. */
export function ungroundedEventTokens(texts: string[], knownEvents: Set<string>): string[] {
  const found = new Set<string>();
  for (const t of texts) {
    for (const m of (t || "").matchAll(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g)) {
      const tok = m[0];
      if (!EVENT_TOKEN_ALLOW.has(tok) && !knownEvents.has(tok)) found.add(tok);
    }
  }
  return [...found];
}
