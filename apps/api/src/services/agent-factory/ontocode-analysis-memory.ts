// #ONTOCODE-MEM — cross-session memory for an OntoCode Ontology ANALYSIS.
//
// ── why this is a separate lane and not the factory's ───────────────────────
// The factory consolidates memory behind exactly one gate: `finishedOk`, which
// only a passing `finish` tool can set — ontology read, every in-scope Agent
// Action covered, generated code for every spec, human-approved test cases, a
// fingerprint-matching sandbox. That is a VERIFIED DELIVERY.
//
// An analysis has no such terminal. Its honest best outcome is "the loop wrote
// its sections inside budget and every citation in them resolved against the
// loaded graph" — a real but strictly weaker grade of fact. Mixing the two
// under one subject would let unverified analysis prose be recalled by a Build
// run as delivery-verified domain truth, so the analysis lane gets its own
// subject (`ontocode-analysis:<domainId>`) which the Build lane's exact-subject
// search can never reach.
//
// ── why an envelope and not a bare string ───────────────────────────────────
// `FactoryMemoryPort.search` returns `{ key, value, score }`. No provenance, no
// tenant. The factory renders recalled facts as `· (key) value`, which the
// model can neither date nor cite nor weigh against a newer contradiction.
//
// Worse, the tenancy boundary is fail-OPEN below the port: both vector drivers
// apply their predicate as `if (scope?.tenantId)` (packages/runtime/src/
// memory-driver-local.ts, apps/api/src/services/memory-pgvector.ts), so a blank
// tenant id silently drops the partition and returns global top-k; and the port
// cannot catch it, because the local driver's `meta` carries no tenantId at all
// (`meta: { agentName, subject, key }`). Isolation therefore rests entirely on
// the driver honouring a scope it is not required to echo back.
//
// So here the ATTRIBUTION ENVELOPE DOUBLES AS THE TENANCY PROOF. Every stored
// value carries its own tenantId/domainId/sourceRunId/at/ontologyHash, and a
// hit whose envelope does not match the caller's STRUCTURAL scope is REFUSED
// and counted — never rendered. A value that does not decode into a fully
// attributed envelope is likewise refused rather than shown with an invented
// "unknown" provenance: an unattributed recall injected into a prompt is
// indistinguishable from the model's own invention.
//
// Scope is derived from (tenantId, ontology.domainId) at the call site. It is
// never a parameter a caller can widen and never anything a model can name.
import { createHash } from "node:crypto";
import type { FactoryMemoryPort, OntologyEntityAnchorIndex } from "@agentic/agent-factory";
import { redactHarnessTelemetryText } from "../ontocode-telemetry-redaction";

// ── knobs (named constants + env overrides; no magic numbers) ────────────────

/** Storage-subject namespace. Keeps the analysis lane disjoint from the Build
 *  lane, whose subject is the bare domain id. */
export const ONTOCODE_ANALYSIS_MEMORY_SUBJECT_PREFIX = "ontocode-analysis:";
/** Envelope discriminator. A value without it is not one of ours. */
export const ONTOCODE_ANALYSIS_MEMORY_SCHEMA = "ontocode-analysis-memory/v1";
/** Storage-key prefix; the suffix is a stable digest of the normalised claim so
 *  re-establishing the same conclusion UPDATES one row instead of duplicating. */
export const ONTOCODE_ANALYSIS_MEMORY_KEY_PREFIX = "ocam-";

/**
 * OntoCode-specific flags rather than the factory's `FACTORY_MEMORY_*`.
 *
 * They gate a different lane, written under a different (weaker) gate, read by
 * a different surface. Sharing the factory flags would mean an operator who
 * wants to stop unverified analysis conclusions from accumulating must also
 * kill the Build brain's proven, delivery-gated flywheel — and vice versa. The
 * POLARITY is deliberately identical to the precedent: on by default, disabled
 * by exactly `"0"`.
 */
export const ONTOCODE_MEMORY_RECALL_ENV = "ONTOCODE_MEMORY_RECALL";
export const ONTOCODE_MEMORY_CONSOLIDATE_ENV = "ONTOCODE_MEMORY_CONSOLIDATE";

/** How many rows to ask the store for (pre-filter). */
export const ONTOCODE_ANALYSIS_MEMORY_SEARCH_K_ENV =
  "ONTOCODE_ANALYSIS_MEMORY_SEARCH_K";
export const ONTOCODE_ANALYSIS_MEMORY_SEARCH_K_DEFAULT = 12;
/** How many attributed hits may reach the model. */
export const ONTOCODE_ANALYSIS_MEMORY_MAX_FACTS_ENV =
  "ONTOCODE_ANALYSIS_MEMORY_MAX_FACTS";
export const ONTOCODE_ANALYSIS_MEMORY_MAX_FACTS_DEFAULT = 5;
/** Minimum similarity a hit must reach to be shown at all. Calibrated for the
 *  default local 256-dim hashed embedder, same as the factory's 0.2. */
export const ONTOCODE_ANALYSIS_MEMORY_MIN_SCORE_ENV =
  "ONTOCODE_ANALYSIS_MEMORY_MIN_SCORE";
export const ONTOCODE_ANALYSIS_MEMORY_MIN_SCORE_DEFAULT = 0.2;
/** How many findings one analysis may write back. */
export const ONTOCODE_ANALYSIS_MEMORY_MAX_WRITES_ENV =
  "ONTOCODE_ANALYSIS_MEMORY_MAX_WRITES";
export const ONTOCODE_ANALYSIS_MEMORY_MAX_WRITES_DEFAULT = 5;
/** Per-claim and per-frame character bounds. */
export const ONTOCODE_ANALYSIS_MEMORY_CLAIM_CHARS = 320;
export const ONTOCODE_ANALYSIS_MEMORY_REFS_SHOWN = 6;
export const ONTOCODE_ANALYSIS_MEMORY_FRAME_CHARS = 1_600;
/** A claim shorter than this is noise, not a durable conclusion. */
export const ONTOCODE_ANALYSIS_MEMORY_MIN_CLAIM_CHARS = 8;

function envInt(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
}

function envFloat(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw >= 0 ? raw : fallback;
}

export function ontoCodeMemoryRecallEnabled(): boolean {
  return process.env[ONTOCODE_MEMORY_RECALL_ENV] !== "0";
}

export function ontoCodeMemoryConsolidateEnabled(): boolean {
  return process.env[ONTOCODE_MEMORY_CONSOLIDATE_ENV] !== "0";
}

// ── scope ────────────────────────────────────────────────────────────────────

export interface OntoCodeAnalysisMemoryScope {
  /** Immutable tenant id. Derived from the authenticated job, never a body. */
  tenantId: string;
  /** Ontology domain id, read off the loaded ontology. */
  domainId: string;
}

/**
 * The one place a storage subject is produced. Blank input FAILS CLOSED — an
 * empty domain would otherwise mint a catch-all subject that every domain in
 * the tenant shares.
 */
export function analysisMemorySubject(domainId: string): string {
  const trimmed = (domainId ?? "").trim();
  if (!trimmed) {
    throw new Error(
      "ontocode analysis memory requires a non-empty ontology domain id",
    );
  }
  return `${ONTOCODE_ANALYSIS_MEMORY_SUBJECT_PREFIX}${trimmed}`;
}

/** Fails closed on a blank tenant: the drivers would drop the partition. */
function requireScope(scope: OntoCodeAnalysisMemoryScope): {
  tenantId: string;
  domainId: string;
  subject: string;
} {
  const tenantId = (scope?.tenantId ?? "").trim();
  if (!tenantId) {
    throw new Error(
      "ontocode analysis memory requires a non-empty tenant id (a blank id disables the store's tenant partition)",
    );
  }
  const subject = analysisMemorySubject(scope?.domainId ?? "");
  return { tenantId, domainId: (scope.domainId ?? "").trim(), subject };
}

// ── the attributed envelope ──────────────────────────────────────────────────

export interface OntoCodeAnalysisMemoryEnvelope {
  schema: typeof ONTOCODE_ANALYSIS_MEMORY_SCHEMA;
  /** Tenancy proof. The store cannot supply one; this is the only copy. */
  tenantId: string;
  /** Domain proof, for the same reason. */
  domainId: string;
  /** The established conclusion, in the analysis's own words. */
  claim: string;
  /** The ontology ids the conclusion was validated against when established. */
  refs: string[];
  /** Unix-ms at which it was established. */
  at: number;
  /** The analysis job that established it — the receipt an FDE can open. */
  sourceRunId: string;
  /** Ontology content hash at establish time; `null` when the source had none.
   *  Lets a reader see the claim predates the current ontology revision. */
  ontologyHash: string | null;
  /**
   * Per-citation content digest at establish time.
   *
   * The whole-ontology hash above answers "was ANYTHING edited since?", which on
   * a live domain is almost always yes and therefore says nothing useful about
   * THIS claim. These digests answer the question that actually matters — did
   * the specific entities this conclusion was checked against change — so a
   * later session can distinguish "still standing" from "needs re-checking"
   * instead of treating every recalled row as equally suspect.
   *
   * OPTIONAL: rows written before this field existed simply have no digests,
   * and are reported as un-re-checkable rather than being assumed intact.
   */
  refDigests?: Record<string, string>;
}

export function encodeAnalysisMemoryValue(
  envelope: OntoCodeAnalysisMemoryEnvelope,
): string {
  return JSON.stringify(envelope);
}

/**
 * Strict decode. Anything that is not a fully attributed envelope returns
 * `null` and is counted as REFUSED by the caller — never rendered, never
 * repaired with a placeholder provenance.
 */
export function decodeAnalysisMemoryValue(
  raw: unknown,
): OntoCodeAnalysisMemoryEnvelope | null {
  if (typeof raw !== "string") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const value = parsed as Record<string, unknown>;
  if (value.schema !== ONTOCODE_ANALYSIS_MEMORY_SCHEMA) return null;
  const text = (field: unknown): string | null =>
    typeof field === "string" && field.trim().length > 0 ? field.trim() : null;
  const tenantId = text(value.tenantId);
  const domainId = text(value.domainId);
  const claim = text(value.claim);
  const sourceRunId = text(value.sourceRunId);
  const at = typeof value.at === "number" && Number.isFinite(value.at) ? value.at : null;
  if (!tenantId || !domainId || !claim || !sourceRunId || at === null) return null;
  if (!Array.isArray(value.refs)) return null;
  const refs = value.refs.filter(
    (ref): ref is string => typeof ref === "string" && ref.trim().length > 0,
  );
  const ontologyHash = typeof value.ontologyHash === "string" ? value.ontologyHash : null;
  const refDigests: Record<string, string> = {};
  if (value.refDigests && typeof value.refDigests === "object" && !Array.isArray(value.refDigests)) {
    for (const [id, digest] of Object.entries(value.refDigests as Record<string, unknown>)) {
      if (typeof digest === "string" && digest.trim().length > 0) refDigests[id] = digest;
    }
  }
  return {
    schema: ONTOCODE_ANALYSIS_MEMORY_SCHEMA,
    tenantId,
    domainId,
    claim,
    refs,
    at,
    sourceRunId,
    ontologyHash,
    // Absent stays ABSENT. An empty object here would later read as "checked,
    // nothing to check", which is a different fact from "never recorded".
    ...(Object.keys(refDigests).length > 0 ? { refDigests } : {}),
  };
}

/** Stable storage key: same conclusion ⇒ same row, across sessions. */
export function analysisMemoryKey(claim: string): string {
  const normalised = claim.trim().replace(/\s+/g, " ").toLowerCase();
  const digest = createHash("sha256").update(normalised).digest("hex").slice(0, 24);
  return `${ONTOCODE_ANALYSIS_MEMORY_KEY_PREFIX}${digest}`;
}

// ── recall ───────────────────────────────────────────────────────────────────

/**
 * How a recalled conclusion stands against the CURRENT ontology.
 *
 * `unchecked` is a first-class state, not a default. A caller with no anchor
 * index has not verified anything, and rendering such a hit with no qualifier
 * would let "we never looked" pass for "we looked and it held".
 */
export type OntoCodeMemoryAnchorState = "intact" | "moved" | "gone" | "unchecked";

export interface OntoCodeAnalysisMemoryHit {
  claim: string;
  refs: string[];
  at: number;
  sourceRunId: string;
  ontologyHash: string | null;
  score: number;
  anchorState: OntoCodeMemoryAnchorState;
  /** Cited ids that no longer resolve. Named, not just counted. */
  missingRefs?: string[];
}

/** A conclusion whose every citation has vanished. Its TEXT is never rendered:
 *  there is nothing left in the ontology to check it against, so injecting it
 *  would be handing the model an assertion it cannot falsify. */
export interface OntoCodeAnalysisWithdrawn {
  claim: string;
  refs: string[];
  sourceRunId: string;
  at: number;
}

export interface OntoCodeAnalysisRecall {
  /** Rows the store returned, BEFORE any filter. The honest denominator. */
  scanned: number;
  /** Rows dropped for unusable or foreign attribution. */
  refused: number;
  /** Rows dropped for scoring below the floor. */
  belowScore: number;
  /** Attributed, in-scope hits that survived, newest-strongest first. */
  hits: OntoCodeAnalysisMemoryHit[];
  /** In-scope conclusions withdrawn because none of their citations survive. */
  withdrawn: OntoCodeAnalysisWithdrawn[];
  /** Model-visible prior-context block; `""` when nothing qualified. */
  frame: string;
  /** Set when the store itself failed. "No memories" and "store is down" must
   *  never look the same. */
  failure?: string;
}

/**
 * Classify one recalled conclusion against the current ontology's anchors.
 *
 * Existence is checked for every citation; content drift is checked only for
 * the citations whose digest was recorded at establish time. A row with no
 * recorded digests can be shown to have LOST a citation but never to have kept
 * an unchanged one, so it settles at `moved` rather than claiming `intact` —
 * "we cannot tell" resolves toward doubt, never toward confidence.
 */
export function classifyAnchorState(
  envelope: Pick<OntoCodeAnalysisMemoryEnvelope, "refs" | "refDigests">,
  anchors: OntologyEntityAnchorIndex | undefined,
): { state: OntoCodeMemoryAnchorState; missingRefs: string[] } {
  if (!anchors) return { state: "unchecked", missingRefs: [] };
  const refs = envelope.refs ?? [];
  if (refs.length === 0) return { state: "unchecked", missingRefs: [] };
  const missingRefs = refs.filter((ref) => !anchors.anchors.has(ref));
  if (missingRefs.length === refs.length) return { state: "gone", missingRefs };
  if (missingRefs.length > 0) return { state: "moved", missingRefs };
  const digests = envelope.refDigests;
  if (!digests || Object.keys(digests).length === 0) {
    return { state: "unchecked", missingRefs: [] };
  }
  const drifted = refs.some((ref) => {
    const recorded = digests[ref];
    return !recorded || anchors.anchors.get(ref)?.digest !== recorded;
  });
  return { state: drifted ? "moved" : "intact", missingRefs: [] };
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function isoDay(at: number): string {
  return new Date(at).toISOString().slice(0, 10);
}

/**
 * Render the prior-context block. It is labelled BACKGROUND, explicitly not
 * this run's evidence, and every line carries where it came from and when.
 * No tenant/domain/vendor vocabulary appears in model-visible text.
 */
/** Per-line staleness verdict. Every recalled line carries one, so a reader can
 *  never mistake "not re-checked" for "re-checked and still true". */
export const ONTOCODE_ANALYSIS_ANCHOR_STATE_LABEL: Record<
  Exclude<OntoCodeMemoryAnchorState, "gone">,
  string
> = {
  intact: "当时引用的实体至今结构未变",
  moved: "当时引用的实体此后已变或已不存在，必须重新读取后才可沿用",
  unchecked: "本次未对当时引用的实体重新核对",
};

export function renderOntoCodeAnalysisPriorContext(
  hits: OntoCodeAnalysisMemoryHit[],
  /** In-scope, attributed conclusions found BEFORE the display cap. Not the raw
   *  row count: rows refused as foreign or unattributed are not "conclusions we
   *  found", and counting them here would overstate what exists. */
  qualified: number,
  /** Conclusions dropped entirely because every citation vanished. Rendered as
   *  ids and a count only — never as text. */
  withdrawn: OntoCodeAnalysisWithdrawn[] = [],
): string {
  if (hits.length === 0 && withdrawn.length === 0) return "";
  const header =
    "【先前会话的分析结论 · 背景，不是本次证据｜来自更早的分析运行｜" +
    "不得直接引用为结论；如仍成立，必须在本次材料中重新取证。与本次本体事实冲突时，以本体为准】";
  const lines = hits.map((hit) => {
    const refs =
      hit.refs.length > 0
        ? `（当时引用：${hit.refs.slice(0, ONTOCODE_ANALYSIS_MEMORY_REFS_SHOWN).join("、")}${
            hit.refs.length > ONTOCODE_ANALYSIS_MEMORY_REFS_SHOWN
              ? `等 ${hit.refs.length} 项`
              : ""
          }）`
        : "（当时无引用）";
    const missing =
      hit.missingRefs && hit.missingRefs.length > 0
        ? `（其中已不存在：${hit.missingRefs
            .slice(0, ONTOCODE_ANALYSIS_MEMORY_REFS_SHOWN)
            .join("、")}${
            hit.missingRefs.length > ONTOCODE_ANALYSIS_MEMORY_REFS_SHOWN
              ? `等 ${hit.missingRefs.length} 项`
              : ""
          }）`
        : "";
    const state =
      hit.anchorState === "gone"
        ? ""
        : ` · ${ONTOCODE_ANALYSIS_ANCHOR_STATE_LABEL[hit.anchorState]}`;
    return `· ${isoDay(hit.at)} · 出自分析 ${hit.sourceRunId}${state} — ${clip(
      hit.claim,
      ONTOCODE_ANALYSIS_MEMORY_CLAIM_CHARS,
    )}${refs}${missing}`;
  });
  // The withdrawal notice exists so the disappearance is INFORMATION rather than
  // silence: a conclusion that quietly stops being recalled looks the same as
  // one that was never established.
  const withdrawnBlock =
    withdrawn.length > 0
      ? [
          `【下列先前结论已撤回：其当时引用的实体在当前本体中均已不存在，结论正文不再提供（共 ${withdrawn.length} 条）】`,
          `· 涉及的实体：${withdrawn
            .flatMap((row) => row.refs)
            .slice(0, ONTOCODE_ANALYSIS_MEMORY_REFS_SHOWN * 2)
            .join("、")}`,
        ]
      : [];
  // Caps always state the real pre-cap count.
  const footer =
    hits.length < qualified
      ? `（本域共检出 ${qualified} 条可用的先前结论，此处只呈现最相关的 ${hits.length} 条）`
      : "";
  const body = [
    header,
    ...lines,
    ...withdrawnBlock,
    ...(footer ? [footer] : []),
  ].join("\n");
  return body.length <= ONTOCODE_ANALYSIS_MEMORY_FRAME_CHARS
    ? body
    : `${body.slice(0, ONTOCODE_ANALYSIS_MEMORY_FRAME_CHARS - 1)}…`;
}

/**
 * Read what previous analyses established about THIS tenant+domain.
 *
 * Never throws for a store problem — a dead vector driver must not kill an
 * analysis — but DOES throw for a blank scope, because that is a boundary
 * violation, not a degraded dependency.
 */
export async function recallOntoCodeAnalysisMemory(
  memory: FactoryMemoryPort,
  scope: OntoCodeAnalysisMemoryScope,
  query: string,
  opts: {
    k?: number;
    maxFacts?: number;
    minScore?: number;
    /** The CURRENT ontology's anchor index. Optional so a store-only caller can
     *  still read; its absence is reported as `unchecked`, never assumed away. */
    anchors?: OntologyEntityAnchorIndex;
  } = {},
): Promise<OntoCodeAnalysisRecall> {
  const { tenantId, domainId, subject } = requireScope(scope);
  const k =
    opts.k ??
    envInt(
      ONTOCODE_ANALYSIS_MEMORY_SEARCH_K_ENV,
      ONTOCODE_ANALYSIS_MEMORY_SEARCH_K_DEFAULT,
    );
  const maxFacts =
    opts.maxFacts ??
    envInt(
      ONTOCODE_ANALYSIS_MEMORY_MAX_FACTS_ENV,
      ONTOCODE_ANALYSIS_MEMORY_MAX_FACTS_DEFAULT,
    );
  const minScore =
    opts.minScore ??
    envFloat(
      ONTOCODE_ANALYSIS_MEMORY_MIN_SCORE_ENV,
      ONTOCODE_ANALYSIS_MEMORY_MIN_SCORE_DEFAULT,
    );

  let rows: Array<{ key: string; value: string; score: number }>;
  try {
    rows = await memory.search(subject, query.slice(0, 2_000), k);
  } catch (error) {
    return {
      scanned: 0,
      refused: 0,
      belowScore: 0,
      hits: [],
      withdrawn: [],
      frame: "",
      failure: error instanceof Error ? error.message : String(error),
    };
  }

  let refused = 0;
  let belowScore = 0;
  const kept: OntoCodeAnalysisMemoryHit[] = [];
  const withdrawn: OntoCodeAnalysisWithdrawn[] = [];
  for (const row of rows) {
    const envelope = decodeAnalysisMemoryValue(row?.value);
    // POST-HIT SCOPE VERIFICATION. The store cannot prove tenancy; the envelope
    // does. A foreign or unattributed row is dropped, not rendered.
    if (
      !envelope ||
      envelope.tenantId !== tenantId ||
      envelope.domainId !== domainId
    ) {
      refused += 1;
      continue;
    }
    const score = typeof row.score === "number" && Number.isFinite(row.score) ? row.score : 0;
    if (score < minScore) {
      belowScore += 1;
      continue;
    }
    // POST-HIT ONTOLOGY VERIFICATION. Scope proved the row is OURS; this proves
    // whether it still says anything about the ontology as it stands now.
    const anchorState = classifyAnchorState(envelope, opts.anchors);
    if (anchorState.state === "gone") {
      withdrawn.push({
        claim: envelope.claim,
        refs: envelope.refs,
        sourceRunId: envelope.sourceRunId,
        at: envelope.at,
      });
      continue;
    }
    kept.push({
      claim: envelope.claim,
      refs: envelope.refs,
      at: envelope.at,
      sourceRunId: envelope.sourceRunId,
      ontologyHash: envelope.ontologyHash,
      score,
      anchorState: anchorState.state,
      ...(anchorState.missingRefs.length > 0
        ? { missingRefs: anchorState.missingRefs }
        : {}),
    });
  }
  kept.sort((a, b) => b.score - a.score || b.at - a.at);
  const hits = kept.slice(0, maxFacts);
  return {
    scanned: rows.length,
    refused,
    belowScore,
    hits,
    withdrawn,
    frame: renderOntoCodeAnalysisPriorContext(hits, kept.length, withdrawn),
  };
}

// ── consolidation ────────────────────────────────────────────────────────────

export type OntoCodeConsolidationRefusal =
  | "flag_off"
  | "no_port"
  | "no_scope"
  /** The analysis could not name itself, so nothing it wrote could be cited. */
  | "no_source_run"
  | "inquiry_absent"
  | "budget_exhausted"
  | "terminated"
  /** #INQUIRY-COMPACT — the analysis only reached a clean stop because part of
   *  what it had read was folded out of its reasoning context first. */
  | "context_folded"
  | "no_citation_valid";

export interface OntoCodeAnalysisConsolidation {
  /** Findings eligible to be written (citation-valid, long enough), pre-cap. */
  candidates: number;
  written: number;
  /** Eligible findings dropped by the per-run write cap. */
  skipped: number;
  /** Findings dropped because they merely RESTATE a conclusion this run was
   *  primed with. They are not re-established and get no fresh provenance. */
  restated?: number;
  refused?: OntoCodeConsolidationRefusal;
  failure?: string;
}

/**
 * The analysis analogue of the factory's `finishedOk`.
 *
 * The factory writes only behind a verified delivery. An analysis cannot reach
 * that bar, so the strongest honest signal is used instead: the inquiry ran to
 * a clean stop (no budget exhaustion, no transport death) AND at least one of
 * its sections had every cited id resolve against the loaded graph. Anything
 * weaker is refused BY NAME, so "nothing was learned" is never confused with
 * "we chose not to trust this run".
 *
 * #INQUIRY-COMPACT — A FOLDED RUN IS NOT AN ESTABLISHED ONE. Context compaction
 * exists precisely to stop `budgetExhausted` being set, so without this rule it
 * would LAUNDER the weakest outcome into the strongest: a run that previously
 * wrote nothing now writes its conclusions to long-term memory, purely because
 * it forgot enough to keep going.
 *
 * The archive is lossless, but losslessness is about RETRIEVAL, not reasoning:
 * the folded material was not in context when the conclusions were written, so
 * those conclusions rest on evidence the run no longer held. That is exactly
 * the standard of "established" this lane is trying to protect. So: any fold at
 * all refuses the write, by name. The conclusions still ship on this run's
 * receipt (with their own fold caveat) — they simply do not become durable
 * background for a future session that cannot re-check them.
 */
export function ontoCodeAnalysisConsolidationVerdict(input: {
  inquiryRan: boolean;
  budgetExhausted: boolean;
  terminated: boolean;
  citationValid: number;
  /** Folds performed by the inquiry loop. Absent is treated as 0 so a caller
   *  that does not yet know cannot be silently downgraded — but every caller
   *  in this repo passes it. */
  contextFolds?: number;
}): { allowed: boolean; refused?: OntoCodeConsolidationRefusal } {
  if (!input.inquiryRan) return { allowed: false, refused: "inquiry_absent" };
  if (input.budgetExhausted) return { allowed: false, refused: "budget_exhausted" };
  if (input.terminated) return { allowed: false, refused: "terminated" };
  if ((input.contextFolds ?? 0) > 0) {
    return { allowed: false, refused: "context_folded" };
  }
  if (input.citationValid <= 0) {
    return { allowed: false, refused: "no_citation_valid" };
  }
  return { allowed: true };
}

export interface OntoCodeConsolidationInput {
  /** The analysis's evaluated findings. Only `citation_valid` ones are eligible. */
  findings: Array<{
    claim: string;
    refs: string[];
    verdict: "citation_valid" | "unverifiable";
  }>;
  /**
   * The conclusions THIS run was primed with by recall, verbatim as they were
   * rendered into the model's prior-context block.
   *
   * A finding that merely restates one of them is not a new establishment: the
   * model read the claim in its own prompt and wrote it back out, and the
   * citation check that follows only asks whether the section mentions ≥1 id
   * that exists in the ontology — never whether the claim was newly evidenced.
   * Re-consolidating it would stamp a FRESH sourceRunId/at/ontologyHash onto an
   * old conclusion, destroying the staleness signal the envelope exists to
   * provide, and would make a claim look continuously re-verified by nothing
   * more than being repeated.
   */
  priorClaims?: string[];
  sourceRunId: string;
  ontologyHash: string | null;
  /** Accepted only so callers can pass the whole receipt shape; it is NEVER
   *  written. What persists are established claims with their citations. */
  rawAnswer?: string;
  /** The CURRENT ontology's anchor index. When supplied, each citation's content
   *  digest is recorded so a later session can tell drift from stability. */
  anchors?: OntologyEntityAnchorIndex;
  now?: number;
  maxWrites?: number;
}

/** Normalised form used for restatement matching (and only for that). */
function claimShape(text: string): string {
  return text.trim().replace(/\s+/gu, "").toLowerCase();
}

/**
 * Is `claim` just `prior` said again?
 *
 * Containment in EITHER direction, on whitespace-stripped text. That covers the
 * two shapes recall actually produces — a verbatim echo, and the recalled line
 * quoted inside a longer section ("如先前分析所述，<claim>；本次未发现相反证据")
 * — without pretending to be a semantic-similarity judge. A model that
 * genuinely re-derives the claim in its own words is treated as new; the cost of
 * that miss is one duplicate row, whereas the cost of the false NEGATIVE this
 * catches is a prior conclusion wearing this run's provenance.
 */
export function restatesPriorClaim(claim: string, priorClaims: readonly string[]): boolean {
  const shape = claimShape(claim);
  if (shape.length < ONTOCODE_ANALYSIS_MEMORY_MIN_CLAIM_CHARS) return false;
  return priorClaims.some((prior) => {
    const priorShape = claimShape(prior);
    if (priorShape.length < ONTOCODE_ANALYSIS_MEMORY_MIN_CLAIM_CHARS) return false;
    return shape.includes(priorShape) || priorShape.includes(shape);
  });
}

/**
 * Write back what this analysis ESTABLISHED — claim + the ids it validated
 * against — each in a fully attributed envelope. The raw answer is never
 * stored: un-cited prose recalled later would be model invention wearing a
 * citation's clothes.
 */
export async function consolidateOntoCodeAnalysisMemory(
  memory: FactoryMemoryPort,
  scope: OntoCodeAnalysisMemoryScope,
  input: OntoCodeConsolidationInput,
): Promise<OntoCodeAnalysisConsolidation> {
  const { tenantId, domainId, subject } = requireScope(scope);
  const sourceRunId = (input.sourceRunId ?? "").trim();
  if (!sourceRunId) {
    // Without provenance the write would be refused by our own recall. Refuse
    // it here instead of persisting a row nothing can ever read.
    throw new Error(
      "ontocode analysis memory requires a source run id — an unattributed fact is refused at recall",
    );
  }
  const maxWrites =
    input.maxWrites ??
    envInt(
      ONTOCODE_ANALYSIS_MEMORY_MAX_WRITES_ENV,
      ONTOCODE_ANALYSIS_MEMORY_MAX_WRITES_DEFAULT,
    );
  const now = input.now ?? Date.now();

  const priorClaims = (input.priorClaims ?? []).filter(
    (claim): claim is string => typeof claim === "string" && claim.trim().length > 0,
  );
  const seen = new Set<string>();
  const eligible: OntoCodeAnalysisMemoryEnvelope[] = [];
  let restated = 0;
  for (const finding of input.findings) {
    if (finding.verdict !== "citation_valid") continue;
    // CREDENTIALS NEVER BECOME MEMORY. The claim is free text the model wrote,
    // and it may have quoted a tool result verbatim. It crosses the same single
    // redaction boundary every other durable Factory/OntoCode string crosses,
    // and it crosses it BEFORE the envelope is built — so no code path between
    // here and `put` can see the unredacted form. Environment-variable NAMES
    // survive (they are configuration, and the analysis is about them); values
    // do not.
    const claim = clip(
      redactHarnessTelemetryText((finding.claim ?? "").trim().replace(/\s+/g, " ")),
      ONTOCODE_ANALYSIS_MEMORY_CLAIM_CHARS,
    );
    if (claim.length < ONTOCODE_ANALYSIS_MEMORY_MIN_CLAIM_CHARS) continue;
    // Break the recall → restate → re-consolidate loop BEFORE the envelope is
    // built, so no fresh `at`/`sourceRunId`/`ontologyHash` is ever minted for a
    // conclusion this run was handed rather than established.
    if (restatesPriorClaim(claim, priorClaims)) {
      restated += 1;
      continue;
    }
    const refs = (finding.refs ?? []).filter(
      (ref) => typeof ref === "string" && ref.trim().length > 0,
    );
    if (refs.length === 0) continue;
    const key = analysisMemoryKey(claim);
    if (seen.has(key)) continue;
    seen.add(key);
    const refDigests: Record<string, string> = {};
    for (const ref of refs) {
      const digest = input.anchors?.anchors.get(ref)?.digest;
      if (digest) refDigests[ref] = digest;
    }
    eligible.push({
      schema: ONTOCODE_ANALYSIS_MEMORY_SCHEMA,
      tenantId,
      domainId,
      claim,
      refs,
      at: now,
      sourceRunId,
      ontologyHash: input.ontologyHash ?? null,
      // Omitted rather than emptied when nothing could be digested: an empty map
      // would later be read as "checked and unchanged".
      ...(Object.keys(refDigests).length > 0 ? { refDigests } : {}),
    });
  }

  const writing = eligible.slice(0, maxWrites);
  let written = 0;
  let failure: string | undefined;
  for (const envelope of writing) {
    try {
      await memory.put(
        subject,
        analysisMemoryKey(envelope.claim),
        encodeAnalysisMemoryValue(envelope),
      );
      written += 1;
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
      break;
    }
  }
  return {
    candidates: eligible.length,
    written,
    skipped: eligible.length - written,
    ...(restated > 0 ? { restated } : {}),
    ...(failure ? { failure } : {}),
  };
}

// ── production port ──────────────────────────────────────────────────────────

/**
 * The tenant-scoped memory port an analysis uses. Composed from the factory's
 * production port (which owns the driver access, the tenant-row re-resolution,
 * and the per-subject capacity cap) and deliberately constructed WITHOUT an
 * ontology domain, because this lane's subject is namespaced and would fail the
 * factory's exact-domain assertion. The subject is still not free-form: every
 * caller in this module routes through `analysisMemorySubject`.
 *
 * `undefined` when the identity needed for a partition is absent — the analysis
 * then runs with no memory at all rather than against an unpartitioned store.
 */
export async function makeOntoCodeAnalysisMemory(identity: {
  tenantId?: string;
  tenantSlug?: string;
}): Promise<FactoryMemoryPort | undefined> {
  const tenantId = (identity.tenantId ?? "").trim();
  const tenantSlug = (identity.tenantSlug ?? "").trim();
  if (!tenantId || !tenantSlug) return undefined;
  // Dynamic import: this module is reached from the OntoCode analyst, and the
  // factory index pulls in the whole store/deployer graph.
  const { makeFactoryPorts } = await import("./index");
  return makeFactoryPorts(tenantSlug, tenantId).memory;
}
