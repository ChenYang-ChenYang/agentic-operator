// #BLUEPRINT-REASON — the reasoning half of an Ontology-grounded blueprint.
//
// `blueprint.ts` is the GROUNDING half: it verifies that every phase/step cites
// a real Ontology id and files everything else under `unresolved`. It is a
// validator, not a generator — hand it a mechanically derived skeleton (one
// phase per selected Action, one step per phase, the Action's own description
// copied into `intent`) and it will happily certify that skeleton as grounded.
// That is exactly what a "blueprint" produced in one second with zero model
// calls was: honest about its anchors, silent about the fact that nothing had
// reasoned.
//
// This module adds the missing half, reusing the Factory brain's own approach
// (`build_blueprint` → `deliberateBlueprintPhases`): run the reasoning kernel
// once per phase, deriving the per-step business logic FROM the Ontology
// evidence, and stream one visible reasoning frame per phase.
//
// Three rules hold this together:
//   1. Reasoning may only enrich what is said ABOUT a real anchor — and only
//      with ids the ontology declares RELATED to the phase's own Action (its
//      trigger/emitted events, target objects, input/output source objects,
//      the objects those events carry/mutate, action_steps rule bindings, and
//      reviewed Links). Every step it proposes is re-grounded through
//      `groundBlueprint` against that related-only view; an id that does not
//      exist goes to `unresolved` as before, and an id that EXISTS but has no
//      declared relation to the phase's Action goes to `unresolved` with
//      reason `unrelated_to_phase_action` — never invented, never laundered
//      by mere existence, and never QUIETLY dropped either (the grounder's
//      own filters are silent, so this module diffs cited-vs-resolved and
//      records the difference itself).
//   2. A phase whose reasoning grounds nothing keeps its mechanical form. The
//      skeleton is a worse blueprint than a reasoned one, but it is a true one.
//   3. Cost is bounded and honest. The shared model-call counter comes from the
//      server-owned command policy; when it cannot fund a full pass the later
//      phases stay mechanical AND the record says which ones, by name.

import {
  buildOntologyAnchorIndex,
  groundBlueprint,
  type BlueprintModel,
  type BlueprintPhase,
  type BlueprintStep,
  type BlueprintUnresolved,
  type OntologyAnchor,
  type OntologyAnchorIndex,
  type OntologyAnchorKind,
} from "./blueprint";
import { extractBalancedJson } from "./json-extract";
// The per-strategy model-call cost table already exists (and is already the
// number the analysis path budgets against). Reusing it keeps one definition of
// "what does a cot pass cost" instead of a second, drifting copy.
import { deliberationStepCost } from "./ontology-inquiry";
// The shared exact-match resolver for `action_steps[].rules[]` — the same one
// rule-gate authoring uses, so "which rules are bound to this Action" has ONE
// definition (no prefix, no fuzzy text, no action-name fallback).
import { resolveActionRuleReferences } from "./rule-gate-evidence";
import type { DomainOntology, OntologyAction } from "./ontology-types";
import { parseStrategyPlan } from "./reasoning-policy";
import { runReasoning, type KernelLlm } from "./reasoning-kernel";
import { isGatewayConfigured } from "./stream-gateway";

// ── knobs (named constants + env overrides; no bare literals) ───────────────

/** The reasoning method(s) run per phase. `cot` = one call per phase. */
export const BLUEPRINT_REASONING_STRATEGY_ENV =
  "ONTOCODE_BLUEPRINT_REASONING_STRATEGY";
export const BLUEPRINT_REASONING_STRATEGY_DEFAULT = "cot";
/** Hard cap on how many phases get a reasoning pass in one blueprint. */
export const BLUEPRINT_REASONING_MAX_PHASES_ENV =
  "ONTOCODE_BLUEPRINT_REASONING_MAX_PHASES";
export const BLUEPRINT_REASONING_MAX_PHASES_DEFAULT = 12;
/** Cap on reasoned steps kept per phase. */
export const BLUEPRINT_REASONING_MAX_STEPS_ENV =
  "ONTOCODE_BLUEPRINT_REASONING_MAX_STEPS_PER_PHASE";
export const BLUEPRINT_REASONING_MAX_STEPS_DEFAULT = 10;
/** How much evidence the kernel is allowed to see for one phase. */
export const BLUEPRINT_REASONING_CONTEXT_CHARS_ENV =
  "ONTOCODE_BLUEPRINT_REASONING_CONTEXT_CHARS";
export const BLUEPRINT_REASONING_CONTEXT_CHARS_DEFAULT = 12_000;
/** How much of the per-phase derivation is kept on the phase / frame. */
export const BLUEPRINT_REASONING_DELIBERATION_CHARS_ENV =
  "ONTOCODE_BLUEPRINT_REASONING_DELIBERATION_CHARS";
export const BLUEPRINT_REASONING_DELIBERATION_CHARS_DEFAULT = 3_500;
/** How many ids of each kind the evidence digest lists (pre-cap count is always stated). */
export const BLUEPRINT_REASONING_ID_LIST_CAP_ENV =
  "ONTOCODE_BLUEPRINT_REASONING_ID_LIST_CAP";
export const BLUEPRINT_REASONING_ID_LIST_CAP_DEFAULT = 120;
/** Attribution purpose for every model call this module makes. */
export const BLUEPRINT_REASONING_PURPOSE = "ontocode.blueprint.reasoning";
/** Grace after a phase's deadline before a signal-deaf kernel is abandoned. */
export const BLUEPRINT_REASONING_PHASE_GRACE_MS_ENV =
  "ONTOCODE_BLUEPRINT_REASONING_PHASE_GRACE_MS";
export const BLUEPRINT_REASONING_PHASE_GRACE_MS_DEFAULT = 2_000;

/** Machine token for "this id exists but the ontology declares no relation
 * between it and the phase's Action". Lives inside `unresolved[].reason` and
 * the per-phase reason vocabulary, so the record — not just the counter —
 * says WHY a real id was refused. */
export const BLUEPRINT_UNRELATED_REFERENCE_REASON = "unrelated_to_phase_action";
/** Per-phase failure reason when the phase's share of the pass deadline ran
 * out before its kernel settled. */
export const BLUEPRINT_PHASE_DEADLINE_REASON = "phase_deadline_exceeded";

/**
 * The sentinel that separates the visible derivation from its machine-readable
 * tail. Exported because the parser and the prompt must agree on ONE token, and
 * because a test that hand-builds a model answer needs the real one.
 */
export const BLUEPRINT_REASONING_STRUCTURE_MARKER = "【结构化步骤】";

/** Static, model-visible section labels of the per-phase evidence digest. */
export const BLUEPRINT_REASONING_CONTEXT_LABELS = {
  phase: "【本阶段】",
  anchors: "【本阶段可用锚点（只能引用这些真实 id）】",
  action: "【该阶段对应的动作定义（权威本体原文）】",
  objects: "【相关对象及其属性】",
  rules: "【本域规则（id / 名称 / 强制级别）】",
  events: "【本域事件】",
  universe: "【本体 id 全集（仅供理解全景；可引用范围以上方可用锚点为准）】",
  currentSteps: "【当前骨架步骤（机械派生，待细化）】",
} as const;

/** Static, model-visible instruction lines. No deployment's nouns may appear. */
export const BLUEPRINT_REASONING_SUBPROBLEM_TEMPLATE = [
  "逐步推导这个阶段真正的业务处理逻辑：它按什么顺序做哪几步，每一步读哪些对象、写哪些对象、触发哪些事件、受哪些规则约束，以及为什么是这个先后。",
  "只能引用上面【本阶段可用锚点】里逐字列出的 id（它们是本体为该阶段动作声明的关联元素）；本体没给的信息就明写「本体未提供」，绝不编造，也不要用同义词改写 id。",
  `推导写完之后，另起一行输出 ${BLUEPRINT_REASONING_STRUCTURE_MARKER}，再输出一个 JSON 对象（不要代码块以外的任何解释）：`,
  '{"steps":[{"label":"这一步做什么","actor":"执行者(可选)","reads":["对象id"],"writes":["对象id"],"emits":["事件id"],"rules":["规则id"],"anchors":[{"kind":"entity|action|rule|event","id":"本体真实id","evidence":"引用它的依据"}]}]}',
  "每个 step 至少给一个 anchors 条目；引用不存在的 id、或与本阶段动作没有本体声明关联的 id，都会被判为未接地并如实记入缺口，不会被当成结论。",
] as const;

const envInt = (name: string, fallback: number): number => {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
};
const envText = (name: string, fallback: string): string =>
  process.env[name]?.trim() || fallback;

const clip = (text: string, max: number): string =>
  text.length > max ? `${text.slice(0, max)}\n…（已截断，原文 ${text.length} 字符）` : text;

// ── public shape ───────────────────────────────────────────────────────────

/** Per-phase outcome. `enriched` is the only one that changed the blueprint. */
export type BlueprintPhaseReasoningStatus =
  /** Reasoned, and its grounded steps replaced the mechanical one. */
  | "enriched"
  /** Reasoned and proposed structure, but nothing in it grounded → mechanical kept. */
  | "unanchored"
  /** Reasoned (prose kept), but produced no machine-readable structure. */
  | "unstructured"
  /** The kernel call failed. */
  | "failed"
  /** Never reasoned (budget / wall clock / phase cap / cancellation). */
  | "skipped";

/** Whole-pass outcome, mirroring the analysis path's deliberation vocabulary. */
export type BlueprintReasoningStatus =
  /** Every phase was reasoned AND enriched. */
  | "completed"
  /** Some phases were enriched, some stayed mechanical. */
  | "degraded"
  /** Nothing was enriched, though the kernel ran (or could not be funded). */
  | "empty"
  /** Every attempted phase failed. */
  | "failed"
  /** No gateway → today's deterministic path, unchanged. */
  | "unavailable";

export interface BlueprintPhaseReasoningRecord {
  id: string;
  title: string;
  status: BlueprintPhaseReasoningStatus;
  /** Why, whenever the status is not `enriched`. Never silently absent. */
  reason?: string;
  stepsBefore: number;
  stepsAfter: number;
  /** Steps the reasoning proposed (pre-cap), and how many survived grounding. */
  stepsProposed: number;
  stepsGrounded: number;
  /** Cited ids that did not exist in the Ontology and were therefore refused. */
  rejectedReferences: number;
  /** Cited ids that DO exist in the Ontology but have no declared relation to
   * this phase's Action (`unrelated_to_phase_action`) — refused, and counted
   * separately so mere existence can never read as grounding. */
  unrelatedReferences: number;
  modelCalls: number;
}

export interface BlueprintReasoningCoverage {
  /** Grounded phases in the model handed in — the real pre-cap count. */
  phases: number;
  phasesReasoned: number;
  phasesMechanical: number;
  reasonedPhaseIds: string[];
  mechanicalPhaseIds: string[];
  /** Phase cap in force, and how many phases it left unreasoned. */
  phaseCap: number;
  phasesOverCap: number;
  modelCalls: number;
  maxModelCalls: number;
  stepsBefore: number;
  stepsAfter: number;
  unresolvedBefore: number;
  unresolvedAfter: number;
  /** Cited-but-nonexistent ids refused across every phase. */
  rejectedReferences: number;
  /** Cited ids that exist but are unrelated to their phase's Action, refused
   * across every phase. */
  unrelatedReferences: number;
}

export interface BlueprintReasoningRecord {
  status: BlueprintReasoningStatus;
  /** The declared method chain, verbatim (lower-cased). */
  declared: string[];
  /** Human-readable account of what ran and what did not. Never empty. */
  detail: string;
  coverage: BlueprintReasoningCoverage;
  phases: BlueprintPhaseReasoningRecord[];
}

/**
 * Visible reasoning frames. Deliberately the SAME vocabulary and payload shape
 * as the analysis path's `harness.ontology_analysis.{strategy,reasoning_step,
 * deliberation}` — one reasoning surface for the FDE, not a third dialect.
 */
export type BlueprintReasoningFrame =
  | {
      type: "strategy";
      mode: "single" | "combo";
      steps: string[];
      chosenBy: "ai" | "default";
      rationale: string;
      suggestion: string;
      estimatedModelCalls: number;
      unknown: string[];
    }
  | {
      type: "reasoning_step";
      strategy: string;
      /** Phase ordinal within the blueprint (0-based), and the phase total. */
      index: number;
      total: number;
      output: string;
      /** Which phase this derivation belongs to. */
      phaseId: string;
      phaseTitle: string;
      error?: string;
    }
  | {
      type: "deliberation";
      status: BlueprintReasoningStatus;
      declared: string[];
      executed: string[];
      dropped: string[];
      detail: string;
      modelCalls: number;
      context: BlueprintReasoningCoverage;
    };

export interface BlueprintReasoningInput {
  /** The mechanically derived, already-grounded blueprint. */
  model: BlueprintModel;
  /** The SAME (overlay-applied) ontology the model was grounded against. */
  ontology: DomainOntology;
  /**
   * Server-owned allowance, shared across every phase.
   *
   * `deadlineAt` is the owning JOB's absolute deadline (unix-ms): the pass
   * deadline becomes `min(passStart + maxWallClockMs, deadlineAt)`, so work
   * the job did BEFORE this pass (ontology fetch, grounding) is no longer
   * re-granted to the pass. Callers that own a job clock should always pass
   * it; without it the pass can only anchor at its own start.
   */
  budget: { maxModelCalls: number; maxWallClockMs: number; deadlineAt?: number };
  onFrame: (frame: BlueprintReasoningFrame) => void | Promise<void>;
  signal?: AbortSignal;
  /** Test/caller override; defaults to `BLUEPRINT_REASONING_MAX_PHASES_*`. */
  maxPhases?: number;
  /** Injection seam; defaults to `isGatewayConfigured`. */
  gatewayConfigured?: () => boolean;
  /** Injection seam; defaults to the real reasoning kernel. */
  reasoningFn?: typeof runReasoning;
  /** Injection seam; drives the REAL kernel with a deterministic transport. */
  reasoningLlm?: KernelLlm;
  now?: () => number;
}

export interface BlueprintReasoningResult {
  /** The enriched model — or, on every degraded path, the one handed in. */
  model: BlueprintModel;
  record: BlueprintReasoningRecord;
}

// ── evidence digest ────────────────────────────────────────────────────────

const idLabel = (item: { id?: string; name?: string }): string =>
  item.name && item.name !== item.id
    ? `${item.id ?? item.name}(${item.name})`
    : (item.id ?? item.name ?? "");

/** A bounded list that ALWAYS states its real pre-cap size. */
function boundedList(items: string[], cap: number): string {
  const kept = items.slice(0, cap).filter(Boolean);
  if (!items.length) return "（无）";
  const suffix =
    items.length > kept.length
      ? `（共 ${items.length} 项，此处列出 ${kept.length} 项，其余未展示）`
      : `（共 ${items.length} 项）`;
  return `${kept.join(" · ")} ${suffix}`;
}

function ruleLabel(rule: Record<string, unknown>): string {
  const id = typeof rule.id === "string" ? rule.id : "";
  const name = typeof rule.name === "string" ? rule.name : "";
  const enforcement =
    typeof rule.enforcement === "string" ? rule.enforcement : "";
  const base = idLabel({ id, name });
  return enforcement ? `${base}[${enforcement}]` : base;
}

function buildPhaseEvidence(
  phase: BlueprintPhase,
  ontology: DomainOntology,
  cap: number,
  related: PhaseRelationSet,
): string {
  const labels = BLUEPRINT_REASONING_CONTEXT_LABELS;
  const anchoredActionIds = new Set(
    phase.anchors.filter((a) => a.kind === "action").map((a) => a.id),
  );
  const actions = (ontology.actions ?? []).filter(
    (action) =>
      anchoredActionIds.has(action.id) || anchoredActionIds.has(action.name),
  );
  const targetObjectIds = new Set(
    actions.flatMap((action) => action.target_objects ?? []),
  );
  const relatedObjects = (ontology.objects ?? []).filter(
    (object) => targetObjectIds.has(object.id) || targetObjectIds.has(object.name),
  );
  // The citable set the grounding gate will actually accept — shown to the
  // model per kind so "只能引用这些真实 id" and the gate agree on ONE list.
  const citable = [
    `action: ${boundedList([...related.action], cap)}`,
    `event: ${boundedList([...related.event], cap)}`,
    `entity: ${boundedList([...related.entity], cap)}`,
    `rule: ${boundedList([...related.rule], cap)}`,
    ...(related.linked.size
      ? [`经 links 声明关联: ${boundedList([...related.linked], cap)}`]
      : []),
  ].join("\n");
  const parts: string[] = [
    `${labels.phase} ${phase.title}${phase.intent ? ` — ${phase.intent}` : ""}`,
    `${labels.anchors}\n${citable}`,
  ];
  for (const action of actions) {
    parts.push(
      [
        `${labels.action} ${idLabel(action)}`,
        action.description ? `描述：${action.description}` : "",
        `消费事件：${(action.trigger ?? []).join(" · ") || "（无）"}`,
        `触发事件：${(action.triggered_event ?? []).join(" · ") || "（无）"}`,
        `目标对象：${(action.target_objects ?? []).join(" · ") || "（无）"}`,
        action.submission_criteria ? `前置条件：${action.submission_criteria}` : "",
        action.instruction ? `业务procedure：${action.instruction}` : "",
        Array.isArray(action.action_steps) && action.action_steps.length
          ? `已声明子步骤：${JSON.stringify(action.action_steps)}`
          : "",
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
  if (relatedObjects.length) {
    parts.push(
      `${labels.objects} ${relatedObjects
        .map(
          (object) =>
            `${idLabel(object)}{${(object.properties ?? [])
              .map((property) => property.name)
              .slice(0, cap)
              .join(",")}}`,
        )
        .join(" · ")}`,
    );
  }
  parts.push(
    `${labels.rules} ${boundedList(
      (ontology.rules ?? []).map((rule) => ruleLabel(rule)),
      cap,
    )}`,
  );
  parts.push(
    `${labels.events} ${boundedList(
      (ontology.events ?? []).map((event) => event.name),
      cap,
    )}`,
  );
  parts.push(
    [
      labels.universe,
      `entity: ${boundedList((ontology.objects ?? []).map(idLabel), cap)}`,
      `action: ${boundedList((ontology.actions ?? []).map(idLabel), cap)}`,
      `rule: ${boundedList((ontology.rules ?? []).map(ruleLabel), cap)}`,
      `event: ${boundedList((ontology.events ?? []).map((e) => e.name), cap)}`,
    ].join("\n"),
  );
  parts.push(
    `${labels.currentSteps} ${
      phase.steps
        .map(
          (step) =>
            `${step.label}[读:${(step.reads ?? []).join(",") || "-"};写:${
              (step.writes ?? []).join(",") || "-"
            };发:${(step.emits ?? []).join(",") || "-"}]`,
        )
        .join(" → ") || "（无）"
    }`,
  );
  return parts.join("\n");
}

// ── parsing the structured tail ────────────────────────────────────────────

interface ProposedStep {
  label: string;
  agent?: string;
  reads: string[];
  writes: string[];
  emits: string[];
  rules: string[];
  anchors: OntologyAnchor[];
}

const ANCHOR_KINDS: readonly OntologyAnchorKind[] = [
  "entity",
  "action",
  "rule",
  "event",
];

function stringList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return [
    ...new Set(
      raw
        .map((value) => (typeof value === "string" ? value.trim() : ""))
        .filter(Boolean),
    ),
  ];
}

function coerceAnchors(raw: unknown): OntologyAnchor[] {
  if (!Array.isArray(raw)) return [];
  const out: OntologyAnchor[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const row = entry as Record<string, unknown>;
    const kind = String(row.kind ?? "").trim() as OntologyAnchorKind;
    const id = String(row.id ?? "").trim();
    if (!id || !ANCHOR_KINDS.includes(kind)) continue;
    out.push({
      kind,
      id,
      ...(typeof row.evidence === "string" && row.evidence.trim()
        ? { evidence: row.evidence.trim() }
        : {}),
    });
  }
  return out;
}

/** Split the kernel's output into the visible derivation and its JSON tail. */
export function splitBlueprintReasoningOutput(final: string): {
  prose: string;
  steps: ProposedStep[] | null;
} {
  const marker = final.lastIndexOf(BLUEPRINT_REASONING_STRUCTURE_MARKER);
  const tail =
    marker >= 0
      ? final.slice(marker + BLUEPRINT_REASONING_STRUCTURE_MARKER.length)
      : final;
  const prose = (marker >= 0 ? final.slice(0, marker) : final).trim();
  const json = extractBalancedJson(tail);
  if (!json) return { prose, steps: null };
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { prose, steps: null };
  }
  const rawSteps = (parsed as { steps?: unknown } | null)?.steps;
  if (!Array.isArray(rawSteps)) return { prose, steps: null };
  const steps: ProposedStep[] = [];
  for (const entry of rawSteps) {
    if (!entry || typeof entry !== "object") continue;
    const row = entry as Record<string, unknown>;
    const label = String(row.label ?? row.name ?? "").trim();
    if (!label) continue;
    const agent =
      typeof row.actor === "string" && row.actor.trim()
        ? row.actor.trim()
        : typeof row.agent === "string" && row.agent.trim()
          ? row.agent.trim()
          : undefined;
    steps.push({
      label,
      ...(agent ? { agent } : {}),
      reads: stringList(row.reads),
      writes: stringList(row.writes),
      emits: stringList(row.emits),
      rules: stringList(row.rules),
      anchors: coerceAnchors(row.anchors),
    });
  }
  return { prose, steps: steps.length ? steps : null };
}

// ── the pass ───────────────────────────────────────────────────────────────

function resolvedIn(index: OntologyAnchorIndex, kind: OntologyAnchorKind, id: string): boolean {
  return index[kind].has(id.normalize("NFKC").trim());
}

// ── per-phase relatedness (the anti-laundering gate) ───────────────────────
//
// An id that merely EXISTS in the ontology is not evidence that it belongs to
// THIS phase. The citable set for a phase is derived from the relations the
// ontology itself declares on the phase's Action(s):
//   action  — the anchored Action's own id/name (other Actions belong to their
//             own phases; the declared interface between phases is the event);
//   event   — the Action's `trigger[]` (consumed) and `triggered_event[]`
//             (emitted) events;
//   entity  — the Action's `target_objects[]`, its `inputs[]`/`outputs[]`
//             `source_object` bindings (readiness' `Object.property`
//             convention, base object taken), and the objects the Action's own
//             events declare via `payload.event_data[].target_object` /
//             `payload.state_mutations[].target_object`;
//   rule    — the Action's `action_steps[].rules[]`, resolved through the SAME
//             exact-match resolver rule-gate authoring uses (an ambiguous or
//             unresolvable reference declares no relation — fail closed);
//   linked  — the opposite endpoint of any reviewed `links[]` row touching the
//             Action, kind-agnostic (grounding still requires the id to exist
//             in the anchor index for the kind the step claims, so a link can
//             relate an id but never launder its kind).
// The phase's OWN resolving anchors are always included — they are the phase's
// declared basis. Prose fields (description/instruction/submission_criteria)
// deliberately declare NOTHING: free text mentioning an id is precisely the
// laundering vector this gate closes.

interface PhaseRelationSet {
  action: Set<string>;
  event: Set<string>;
  entity: Set<string>;
  rule: Set<string>;
  /** Related through reviewed Links regardless of kind. */
  linked: Set<string>;
}

const normId = (value: unknown): string =>
  typeof value === "string" ? value.normalize("NFKC").trim() : "";

function buildPhaseRelationSet(
  phase: BlueprintPhase,
  ontology: DomainOntology,
  index: OntologyAnchorIndex,
): PhaseRelationSet {
  const rel: PhaseRelationSet = {
    action: new Set(),
    event: new Set(),
    entity: new Set(),
    rule: new Set(),
    linked: new Set(),
  };
  const add = (kind: OntologyAnchorKind, value: unknown): void => {
    const id = normId(value);
    if (id) rel[kind].add(id);
  };

  // The phase's own resolving anchors are its declared basis.
  for (const anchor of phase.anchors) {
    if (resolvedIn(index, anchor.kind, anchor.id)) add(anchor.kind, anchor.id);
  }

  const anchoredActionKeys = new Set(
    phase.anchors
      .filter((anchor) => anchor.kind === "action")
      .map((anchor) => normId(anchor.id))
      .filter(Boolean),
  );
  const actions: OntologyAction[] = (ontology.actions ?? []).filter(
    (action) =>
      anchoredActionKeys.has(normId(action.id)) ||
      anchoredActionKeys.has(normId(action.name)),
  );

  const objectByKey = new Map<string, { id: string; name: string }>();
  for (const object of ontology.objects ?? []) {
    const row = { id: object.id, name: object.name };
    if (normId(object.id)) objectByKey.set(normId(object.id), row);
    if (normId(object.name)) objectByKey.set(normId(object.name), row);
  }
  // Anchors may cite either the label id or the display name (the anchor index
  // accepts both), so a related object contributes BOTH of its identifiers.
  const addEntity = (value: unknown): void => {
    const key = normId(value);
    if (!key) return;
    add("entity", key);
    const object = objectByKey.get(key);
    if (object) {
      add("entity", object.id);
      add("entity", object.name);
    }
  };

  const eventByName = new Map(
    (ontology.events ?? []).map((event) => [normId(event.name), event]),
  );
  const domainRules = (ontology.rules ?? []) as Record<string, unknown>[];

  for (const action of actions) {
    add("action", action.id);
    add("action", action.name);

    for (const eventName of [
      ...(action.trigger ?? []),
      ...(action.triggered_event ?? []),
    ]) {
      add("event", eventName);
      const event = eventByName.get(normId(eventName));
      if (!event) continue;
      add("event", event.name);
      // The objects the Action's own events declare they carry / mutate.
      for (const field of event.payload?.event_data ?? []) {
        if (field?.target_object) addEntity(field.target_object);
      }
      for (const mutation of event.payload?.state_mutations ?? []) {
        if (mutation?.target_object) addEntity(mutation.target_object);
      }
    }

    for (const target of action.target_objects ?? []) addEntity(target);
    for (const row of [...(action.inputs ?? []), ...(action.outputs ?? [])]) {
      const source =
        (row as { source_object?: unknown }).source_object ??
        (row as { sourceObject?: unknown }).sourceObject;
      if (typeof source === "string" && source.trim()) {
        // `Object.property` binding form — relate the base object.
        addEntity(source.split(".", 1)[0]);
      }
    }

    const ruleResolution = resolveActionRuleReferences(action, domainRules);
    for (const rule of ruleResolution.relevantRules) {
      add("rule", rule.id);
      add("rule", rule.name);
    }

    const actionKeys = new Set(
      [normId(action.id), normId(action.name)].filter(Boolean),
    );
    for (const link of ontology.links ?? []) {
      const fromId = normId(link.from?.id);
      const toId = normId(link.to?.id);
      if (actionKeys.has(fromId) && toId) rel.linked.add(toId);
      if (actionKeys.has(toId) && fromId) rel.linked.add(fromId);
    }
  }

  return rel;
}

function relatedIn(
  rel: PhaseRelationSet,
  kind: OntologyAnchorKind,
  id: string,
): boolean {
  const key = normId(id);
  return rel[kind].has(key) || rel.linked.has(key);
}

/** The anchor index restricted to THIS phase's related ids — handing it to
 * `groundBlueprint` makes "exists but unrelated" structurally ungroundable
 * instead of relying on a post-hoc filter someone could forget. */
function narrowIndexToRelated(
  index: OntologyAnchorIndex,
  rel: PhaseRelationSet,
): OntologyAnchorIndex {
  const narrow = (kind: OntologyAnchorKind): Set<string> =>
    new Set([...index[kind]].filter((id) => rel[kind].has(id) || rel.linked.has(id)));
  return {
    entity: narrow("entity"),
    action: narrow("action"),
    rule: narrow("rule"),
    event: narrow("event"),
  };
}

interface PhaseGroundingOutcome {
  phase: BlueprintPhase;
  unresolved: BlueprintUnresolved[];
  rejectedReferences: number;
  unrelatedReferences: number;
  grounded: number;
}

const NONEXISTENT_REFERENCE_REASON =
  "推理引用的这些 id 在权威本体里不存在，已拒绝采纳（未写入步骤明细，也未编造替代）";
const UNRELATED_REFERENCE_REASON =
  `${BLUEPRINT_UNRELATED_REFERENCE_REASON}：这些 id 在权威本体中存在，但与本阶段对应的动作没有本体声明的关联` +
  "（trigger/triggered_event/target_objects/inputs·outputs.source_object/事件载荷对象/action_steps.rules/links），" +
  "已拒绝采纳（未写入步骤明细，也未静默丢弃）";

/**
 * Ground ONE phase's reasoned steps against the phase's RELATED-only view of
 * the ontology. Everything the grounder filters silently (a non-resolving or
 * unrelated anchor on an otherwise-valid step, a fabricated read/write/emit,
 * an existing-but-unrelated reference) is diffed back out here and recorded —
 * "quietly dropped" is the same failure mode as "invented", one turn later.
 */
function groundReasonedPhase(
  phase: BlueprintPhase,
  proposed: ProposedStep[],
  index: OntologyAnchorIndex,
  related: PhaseRelationSet,
  domain: string,
): PhaseGroundingOutcome {
  const candidateSteps: BlueprintStep[] = proposed.map((step) => ({
    label: step.label,
    ...(step.agent ? { agent: step.agent } : {}),
    ...(step.reads.length ? { reads: step.reads } : {}),
    ...(step.writes.length ? { writes: step.writes } : {}),
    ...(step.emits.length ? { emits: step.emits } : {}),
    anchors: [
      ...step.anchors,
      // "Which rules constrain this step" is an anchor claim like any other, so
      // it is grounded as one instead of riding along as free text.
      ...step.rules.map((id) => ({
        kind: "rule" as const,
        id,
        evidence: "推理声明本步骤受该规则约束",
      })),
    ],
  }));
  // The grounder runs on the related-only index, so an id that merely EXISTS
  // in the ontology is structurally ungroundable for this phase.
  const groundedModel = groundBlueprint(
    { domain, phases: [{ ...phase, steps: candidateSteps }] },
    narrowIndexToRelated(index, related),
  );
  const groundedPhase = groundedModel.phases[0];
  // Step-scope accounting is rebuilt here IN FULL (the grounder's own entries
  // are discarded): only this loop can say whether a refused id was invented
  // or merely unrelated, and it must also see the ids the grounder never
  // records at all — the reads/writes/emits of a step that died whole.
  const unresolved: BlueprintUnresolved[] = [];
  let rejectedReferences = 0;
  let unrelatedReferences = 0;
  for (const candidate of candidateSteps) {
    // The grounder's own survival predicate, re-evaluated here rather than by
    // pairing candidates with survivors: two steps the model happened to name
    // the same would make any label- or order-based pairing wrong.
    const nonexistentAnchors: OntologyAnchor[] = [];
    const unrelatedAnchors: OntologyAnchor[] = [];
    let survivingAnchors = 0;
    for (const anchor of candidate.anchors) {
      if (!resolvedIn(index, anchor.kind, anchor.id)) {
        nonexistentAnchors.push(anchor);
      } else if (!relatedIn(related, anchor.kind, anchor.id)) {
        unrelatedAnchors.push(anchor);
      } else {
        survivingAnchors += 1;
      }
    }
    const nonexistentRefs: OntologyAnchor[] = [];
    const unrelatedRefs: OntologyAnchor[] = [];
    for (const [slot, kind] of [
      ["reads", "entity"],
      ["writes", "entity"],
      ["emits", "event"],
    ] as Array<[keyof BlueprintStep & ("reads" | "writes" | "emits"), OntologyAnchorKind]>) {
      for (const id of candidate[slot] ?? []) {
        const evidence = `推理把它列为该步骤的 ${slot}`;
        if (!resolvedIn(index, kind, id)) {
          nonexistentRefs.push({ kind, id, evidence });
        } else if (!relatedIn(related, kind, id)) {
          unrelatedRefs.push({ kind, id, evidence });
        }
      }
    }

    const ref = `${phase.id}/${candidate.label}`;
    if (survivingAnchors === 0) {
      // The whole step is refused (the grounder, on the related-only index,
      // adopted nothing). The step itself is an unresolved STEP — its anchors
      // are not counted as refused references — but its fabricated / unrelated
      // reads·writes·emits ARE still inventions and are counted and recorded
      // below instead of dying uncounted with the step.
      unresolved.push({
        scope: "step",
        ref,
        reason:
          `步骤没有任何可采纳的锚点（${nonexistentAnchors.length} 个 id 在本体中不存在` +
          (unrelatedAnchors.length
            ? `，${unrelatedAnchors.length} 个 id 存在但 ${BLUEPRINT_UNRELATED_REFERENCE_REASON}`
            : "") +
          "），整步未采纳",
        citedAnchors: [...nonexistentAnchors, ...unrelatedAnchors],
      });
    }
    const refusedNonexistent = [
      ...(survivingAnchors > 0 ? nonexistentAnchors : []),
      ...nonexistentRefs,
    ];
    const refusedUnrelated = [
      ...(survivingAnchors > 0 ? unrelatedAnchors : []),
      ...unrelatedRefs,
    ];
    if (refusedNonexistent.length) {
      rejectedReferences += refusedNonexistent.length;
      unresolved.push({
        scope: "step",
        ref,
        reason: NONEXISTENT_REFERENCE_REASON,
        citedAnchors: refusedNonexistent,
      });
    }
    if (refusedUnrelated.length) {
      unrelatedReferences += refusedUnrelated.length;
      unresolved.push({
        scope: "step",
        ref,
        reason: UNRELATED_REFERENCE_REASON,
        citedAnchors: refusedUnrelated,
      });
    }
  }
  return {
    phase: groundedPhase ?? phase,
    unresolved,
    rejectedReferences,
    unrelatedReferences,
    grounded: groundedPhase?.steps.length ?? 0,
  };
}

export async function reasonBlueprintPhases(
  input: BlueprintReasoningInput,
): Promise<BlueprintReasoningResult> {
  const now = input.now ?? Date.now;
  const model = input.model;
  const phases = model.phases;
  const declaredPlan = parseStrategyPlan(
    envText(
      BLUEPRINT_REASONING_STRATEGY_ENV,
      BLUEPRINT_REASONING_STRATEGY_DEFAULT,
    ),
    {
      rationale: "逐阶段从本体证据推导该阶段的业务处理逻辑",
      chosenBy: "default",
    },
  );
  const declared = declaredPlan.steps.map((step) =>
    String(step.strategy).toLowerCase(),
  );
  const perPhaseCost = declared.reduce(
    (sum, strategy) => sum + deliberationStepCost(strategy, 3, false),
    0,
  );
  const phaseCap = Math.max(
    1,
    input.maxPhases ??
      envInt(
        BLUEPRINT_REASONING_MAX_PHASES_ENV,
        BLUEPRINT_REASONING_MAX_PHASES_DEFAULT,
      ),
  );
  const maxSteps = envInt(
    BLUEPRINT_REASONING_MAX_STEPS_ENV,
    BLUEPRINT_REASONING_MAX_STEPS_DEFAULT,
  );
  const contextChars = envInt(
    BLUEPRINT_REASONING_CONTEXT_CHARS_ENV,
    BLUEPRINT_REASONING_CONTEXT_CHARS_DEFAULT,
  );
  const deliberationChars = envInt(
    BLUEPRINT_REASONING_DELIBERATION_CHARS_ENV,
    BLUEPRINT_REASONING_DELIBERATION_CHARS_DEFAULT,
  );
  const idListCap = envInt(
    BLUEPRINT_REASONING_ID_LIST_CAP_ENV,
    BLUEPRINT_REASONING_ID_LIST_CAP_DEFAULT,
  );

  const stepsBefore = phases.reduce((sum, phase) => sum + phase.steps.length, 0);
  const baseCoverage = (): BlueprintReasoningCoverage => ({
    phases: phases.length,
    phasesReasoned: 0,
    phasesMechanical: phases.length,
    reasonedPhaseIds: [],
    mechanicalPhaseIds: phases.map((phase) => phase.id),
    phaseCap,
    phasesOverCap: Math.max(0, phases.length - phaseCap),
    modelCalls: 0,
    maxModelCalls: input.budget.maxModelCalls,
    stepsBefore,
    stepsAfter: stepsBefore,
    unresolvedBefore: model.unresolved.length,
    unresolvedAfter: model.unresolved.length,
    rejectedReferences: 0,
    unrelatedReferences: 0,
  });

  const gatewayCheck = input.gatewayConfigured ?? isGatewayConfigured;
  const gatewayReady = Boolean(input.reasoningLlm) || gatewayCheck();
  if (!gatewayReady || phases.length === 0) {
    // Exactly today's behaviour, byte for byte — and NO frame, so the durable
    // event stream is the one this stage always had. The honesty lives on the
    // receipt: a deterministic skeleton must not read as fast thinking.
    return {
      model,
      record: {
        // "unavailable" is reserved for the no-gateway path; an empty blueprint
        // is a different fact and must not borrow its name.
        status: gatewayReady ? "empty" : "unavailable",
        declared,
        detail: !gatewayReady
          ? `模型网关未接入，本次蓝图只有确定性骨架：${phases.length} 个阶段全部按选中的本体动作机械派生（每阶段 1 步、意图直接取自动作描述），没有做任何推理，已用模型调用 0/${input.budget.maxModelCalls}。`
          : `本次蓝图没有任何可接地的阶段（0 个），没有可推理的对象；已用模型调用 0/${input.budget.maxModelCalls}。`,
        coverage: baseCoverage(),
        phases: phases.map((phase) => ({
          id: phase.id,
          title: phase.title,
          status: "skipped" as const,
          reason: !gatewayReady ? "gateway_unavailable" : "no_grounded_phase",
          stepsBefore: phase.steps.length,
          stepsAfter: phase.steps.length,
          stepsProposed: 0,
          stepsGrounded: 0,
          rejectedReferences: 0,
          unrelatedReferences: 0,
          modelCalls: 0,
        })),
      },
    };
  }

  const index = buildOntologyAnchorIndex(input.ontology);
  const reasoningFn = input.reasoningFn ?? runReasoning;
  // #P2-WALLCLOCK — the pass deadline is bounded by the JOB's own deadline
  // when the caller provides one: the ontology fetch / grounding the job did
  // BEFORE this pass must not be re-granted to the pass as fresh time.
  const deadlineAt = Math.min(
    now() + input.budget.maxWallClockMs,
    input.budget.deadlineAt ?? Number.POSITIVE_INFINITY,
  );
  const phaseGraceMs = envInt(
    BLUEPRINT_REASONING_PHASE_GRACE_MS_ENV,
    BLUEPRINT_REASONING_PHASE_GRACE_MS_DEFAULT,
  );
  const emit = async (frame: BlueprintReasoningFrame) => {
    await input.onFrame(frame);
  };

  await emit({
    type: "strategy",
    mode: declaredPlan.mode,
    steps: declared,
    chosenBy: declaredPlan.chosenBy,
    rationale: declaredPlan.rationale,
    suggestion: BLUEPRINT_REASONING_STRATEGY_DEFAULT,
    estimatedModelCalls: perPhaseCost * Math.min(phases.length, phaseCap),
    unknown: declaredPlan.unknown,
  });

  let modelCalls = 0;
  let rejectedReferences = 0;
  let unrelatedReferences = 0;
  const extraUnresolved: BlueprintUnresolved[] = [];
  const phaseRecords: BlueprintPhaseReasoningRecord[] = [];
  const outPhases: BlueprintPhase[] = [];
  const executed: string[] = [];

  for (let i = 0; i < phases.length; i += 1) {
    const phase = phases[i]!;
    const keepMechanical = (
      status: BlueprintPhaseReasoningStatus,
      reason: string,
      extra: Partial<BlueprintPhaseReasoningRecord> = {},
    ) => {
      outPhases.push(phase);
      phaseRecords.push({
        id: phase.id,
        title: phase.title,
        status,
        reason,
        stepsBefore: phase.steps.length,
        stepsAfter: phase.steps.length,
        stepsProposed: 0,
        stepsGrounded: 0,
        rejectedReferences: 0,
        unrelatedReferences: 0,
        modelCalls: 0,
        ...extra,
      });
    };

    if (input.signal?.aborted) {
      keepMechanical("skipped", "cancelled");
      continue;
    }
    if (i >= phaseCap) {
      keepMechanical("skipped", "phase_cap");
      continue;
    }
    if (modelCalls + perPhaseCost > input.budget.maxModelCalls) {
      keepMechanical("skipped", "budget_exhausted");
      continue;
    }
    if (now() >= deadlineAt) {
      keepMechanical("skipped", "time_exhausted");
      continue;
    }

    // The related-id set this phase may cite — built once, then used by BOTH
    // the evidence digest (what the model is told it may cite) and the
    // grounding gate (what actually grounds), so the two cannot disagree.
    const related = buildPhaseRelationSet(phase, input.ontology, index);

    // #P2-WALLCLOCK — this phase's fair share of what is LEFT of the pass
    // deadline: remaining time divided over the phases still eligible under
    // the cap. The share aborts the kernel's signal at the deadline and hard-
    // abandons a signal-deaf kernel a bounded grace later, so one stuck phase
    // can overrun its own share only — never the remaining phases' time.
    const remainingSlots = Math.max(1, Math.min(phaseCap, phases.length) - i);
    const phaseShareMs = Math.max(
      1,
      Math.floor((deadlineAt - now()) / remainingSlots),
    );
    const phaseController = new AbortController();
    const phaseSignal = input.signal
      ? AbortSignal.any([input.signal, phaseController.signal])
      : phaseController.signal;
    const abortTimer = setTimeout(
      () => phaseController.abort(new Error(BLUEPRINT_PHASE_DEADLINE_REASON)),
      phaseShareMs,
    );
    let killTimer: ReturnType<typeof setTimeout> | undefined;

    const before = modelCalls;
    let final = "";
    let kernelError: string | undefined;
    try {
      const work = reasoningFn(
        {
          subproblem: `${BLUEPRINT_REASONING_SUBPROBLEM_TEMPLATE.join("\n")}\n阶段：「${phase.title}」`,
          context: buildPhaseEvidence(phase, input.ontology, idListCap, related),
          limits: { contextChars },
        },
        declaredPlan,
        {
          maxLlmCalls: perPhaseCost,
          onLlmCall: () => {
            modelCalls += 1;
          },
          ...(input.reasoningLlm ? { llm: input.reasoningLlm } : {}),
          signal: phaseSignal,
        },
      );
      // A settlement AFTER the race has moved on must not become an unhandled
      // rejection (its calls are still charged via the shared counter).
      work.catch(() => {});
      const kernel = await Promise.race([
        work,
        new Promise<never>((_, reject) => {
          killTimer = setTimeout(
            () => reject(new Error(BLUEPRINT_PHASE_DEADLINE_REASON)),
            phaseShareMs + phaseGraceMs,
          );
        }),
      ]);
      final = kernel.ambientReactOnly ? "" : kernel.final.trim();
      kernelError = kernel.steps.find(
        (step) => typeof step.meta?.error === "string",
      )?.meta?.error as string | undefined;
      for (const step of kernel.steps) {
        if (!executed.includes(step.strategy)) executed.push(step.strategy);
      }
    } catch (error) {
      kernelError = String((error as Error)?.message ?? error).slice(0, 200);
    } finally {
      clearTimeout(abortTimer);
      if (killTimer !== undefined) clearTimeout(killTimer);
    }
    const spent = modelCalls - before;

    if (!final) {
      const phaseDeadlineHit = phaseController.signal.aborted;
      keepMechanical(
        kernelError || phaseDeadlineHit ? "failed" : "unstructured",
        kernelError ??
          (phaseDeadlineHit
            ? BLUEPRINT_PHASE_DEADLINE_REASON
            : "kernel_returned_empty"),
        { modelCalls: spent },
      );
      continue;
    }

    const { prose, steps } = splitBlueprintReasoningOutput(final);
    const deliberation = clip(prose || final, deliberationChars);
    await emit({
      type: "reasoning_step",
      strategy: declared.join("→"),
      index: i,
      total: phases.length,
      output: deliberation,
      phaseId: phase.id,
      phaseTitle: phase.title,
      ...(kernelError ? { error: kernelError } : {}),
    });

    if (!steps) {
      // The derivation ran and is kept; only its machine-readable half is
      // missing, so the structure stays exactly as it was.
      outPhases.push({ ...phase, deliberation });
      phaseRecords.push({
        id: phase.id,
        title: phase.title,
        status: "unstructured",
        reason: "推理未给出可解析的结构化步骤，阶段保留机械骨架",
        stepsBefore: phase.steps.length,
        stepsAfter: phase.steps.length,
        stepsProposed: 0,
        stepsGrounded: 0,
        rejectedReferences: 0,
        unrelatedReferences: 0,
        modelCalls: spent,
      });
      continue;
    }

    const capped = steps.slice(0, maxSteps);
    const outcome = groundReasonedPhase(
      phase,
      capped,
      index,
      related,
      model.domain,
    );
    extraUnresolved.push(...outcome.unresolved);
    rejectedReferences += outcome.rejectedReferences;
    unrelatedReferences += outcome.unrelatedReferences;

    if (outcome.grounded === 0) {
      // Nothing anchorable came back. The phase keeps its honest mechanical
      // form rather than being dropped — and says so.
      extraUnresolved.push({
        scope: "phase",
        ref: phase.id,
        reason:
          "推理提出的步骤全部无法在本体中接地；本阶段保留机械派生的骨架步骤（未丢弃，也未采纳未接地内容）",
        citedAnchors: capped.flatMap((step) => step.anchors),
      });
      outPhases.push({ ...phase, deliberation });
      phaseRecords.push({
        id: phase.id,
        title: phase.title,
        status: "unanchored",
        reason: "推理产出的步骤没有一条能接地",
        stepsBefore: phase.steps.length,
        stepsAfter: phase.steps.length,
        stepsProposed: steps.length,
        stepsGrounded: 0,
        rejectedReferences: outcome.rejectedReferences,
        unrelatedReferences: outcome.unrelatedReferences,
        modelCalls: spent,
      });
      continue;
    }

    outPhases.push({ ...outcome.phase, deliberation });
    phaseRecords.push({
      id: phase.id,
      title: phase.title,
      status: "enriched",
      ...(steps.length > capped.length
        ? {
            reason: `推理提出 ${steps.length} 步，按每阶段上限 ${maxSteps} 步保留前 ${capped.length} 步`,
          }
        : {}),
      stepsBefore: phase.steps.length,
      stepsAfter: outcome.phase.steps.length,
      stepsProposed: steps.length,
      stepsGrounded: outcome.grounded,
      rejectedReferences: outcome.rejectedReferences,
      unrelatedReferences: outcome.unrelatedReferences,
      modelCalls: spent,
    });
  }

  const enriched = phaseRecords.filter((row) => row.status === "enriched");
  const attempted = phaseRecords.filter((row) => row.status !== "skipped");
  const failed = phaseRecords.filter((row) => row.status === "failed");
  const status: BlueprintReasoningStatus =
    enriched.length === phases.length
      ? "completed"
      : enriched.length > 0
        ? "degraded"
        : attempted.length > 0 && failed.length === attempted.length
          ? "failed"
          : "empty";

  const enrichedModel: BlueprintModel = {
    ...model,
    phases: outPhases,
    unresolved: [...model.unresolved, ...extraUnresolved],
  };
  const stepsAfter = outPhases.reduce((sum, phase) => sum + phase.steps.length, 0);
  const mechanical = phaseRecords.filter((row) => row.status !== "enriched");
  const coverage: BlueprintReasoningCoverage = {
    phases: phases.length,
    phasesReasoned: enriched.length,
    phasesMechanical: mechanical.length,
    reasonedPhaseIds: enriched.map((row) => row.id),
    mechanicalPhaseIds: mechanical.map((row) => row.id),
    phaseCap,
    phasesOverCap: Math.max(0, phases.length - phaseCap),
    modelCalls,
    maxModelCalls: input.budget.maxModelCalls,
    stepsBefore,
    stepsAfter,
    unresolvedBefore: model.unresolved.length,
    unresolvedAfter: enrichedModel.unresolved.length,
    rejectedReferences,
    unrelatedReferences,
  };

  const reasonCounts = new Map<string, number>();
  for (const row of mechanical) {
    const key = row.reason ?? row.status;
    reasonCounts.set(key, (reasonCounts.get(key) ?? 0) + 1);
  }
  const detail = [
    `推理方法「${declared.join("→")}」：共 ${phases.length} 个阶段，已逐阶段推理并接地 ${enriched.length} 个，${mechanical.length} 个保留机械骨架。`,
    mechanical.length
      ? `保留机械骨架的阶段：${mechanical
          .map((row) => `${row.title}(${row.reason ?? row.status})`)
          .join("、")}。`
      : "",
    `已用模型调用 ${modelCalls}/${input.budget.maxModelCalls}（预算来自服务端命令策略，每阶段 ${perPhaseCost} 次）。`,
    coverage.phasesOverCap > 0
      ? `阶段上限 ${phaseCap}，本次共 ${phases.length} 个阶段，其中 ${coverage.phasesOverCap} 个超出上限未推理。`
      : "",
    rejectedReferences > 0
      ? `另有 ${rejectedReferences} 处推理引用的 id 在本体中不存在，已如实记入缺口而不是写进结论。`
      : "",
    unrelatedReferences > 0
      ? `另有 ${unrelatedReferences} 处引用的 id 虽在本体中存在，但与所在阶段的动作没有本体声明的关联（${BLUEPRINT_UNRELATED_REFERENCE_REASON}），已如实记入缺口而不是当作接地。`
      : "",
  ]
    .filter(Boolean)
    .join("");

  await emit({
    type: "deliberation",
    status,
    declared,
    executed,
    dropped: declared.filter((strategy) => !executed.includes(strategy)),
    detail,
    modelCalls,
    context: coverage,
  });

  return {
    model: enrichedModel,
    record: { status, declared, detail, coverage, phases: phaseRecords },
  };
}
