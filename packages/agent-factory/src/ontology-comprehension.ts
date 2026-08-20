// #ONTOCODE-COMPREHEND — the UNDERSTANDING layer (T2).
//
// ── why a third layer, and not "just recall harder" ─────────────────────────
// The long-term lane (#ONTOCODE-MEM) stores conclusions addressed by VECTOR
// SIMILARITY. That is the right shape for "what did earlier sessions come to
// believe about this business", and the wrong shape for "what does this ontology
// mean". A similarity search cannot answer "is this still true?", because the
// thing that makes it stale — the ontology changing underneath it — has no
// representation in the embedding at all. So a recalled conclusion can only ever
// be BACKGROUND: it is injected with its provenance and explicitly denied the
// standing of fact.
//
// The understanding layer is the opposite on every axis:
//   · addressed EXACTLY, by (tenant, domain, ontologyHash) — never by similarity;
//   · invalidated PER ANCHOR, by comparing each entity's content digest, so one
//     edited rule costs one re-read instead of the whole understanding;
//   · produced WITHOUT the FDE's question in the prompt, so the same ontology
//     yields the same understanding no matter who asked what.
//
// That last property is enforced structurally, not by convention: there is no
// question field on `ComprehensionPromptInput`, and the exported template carries
// no `{question}` slot. Two consequences follow, and both are load-bearing:
// the pack is reusable across sessions, and — because it provably contains no
// conversation content — deleting a Session does not have to delete it (the
// Session purge says so in its retention notes rather than silently keeping it).
//
// ── why not reuse factory_domain_insights ───────────────────────────────────
// The Build lane's insight store is the ancestor of this design: keyed on
// `(tenant_id, domain, ontology_sig)`, it misses naturally when the ontology
// moves instead of running an eviction job. But its `digest` column holds one
// prose blob and its `mode` is a `shallow|deep` enum; storing per-anchor
// annotations there would make both column names lie, and namespacing the domain
// to avoid collisions would pollute the Build lane's query surface. A separate
// table is cheaper and more honest.

import { canonicalEvidenceJson } from "@agentic/shared";
import {
  declaredRuleAnchorId,
  indexOntologyAnchors,
  type OntologyEntityAnchorIndex,
  type OntologyEntityAnchorKind,
} from "./ontology-entity-digest";
import type { DomainOntology } from "./ontology-types";

export const ONTOLOGY_COMPREHENSION_SCHEMA = "ontocode-ontology-comprehension/v1";

/** Upper bound for ONE annotation's proposition. Over it, the model is asked to
 *  rewrite once and then REFUSED — never clipped. A clipped proposition reads
 *  back as a sentence whose truth cannot be judged, which is exactly the defect
 *  that made the long-term lane's stored sections unusable as input. */
export const ONTOLOGY_COMPREHENSION_ROLE_CHARS = 400;
/** Entities per annotator call. */
export const ONTOLOGY_COMPREHENSION_BATCH_SIZE = 12;
/** Character ceiling for one batch's declarations. A batch over it FAILS; it is
 *  never folded, so this layer trivially satisfies "nothing lossy gets stored". */
export const ONTOLOGY_COMPREHENSION_BATCH_CHARS = 60_000;
/** Characters of prior understanding that may be injected into one analysis. */
export const ONTOLOGY_COMPREHENSION_FRAME_CHARS = 6_000;
/** How many moved/withdrawn ids are named before the line reports a real total. */
export const ONTOLOGY_COMPREHENSION_IDS_SHOWN = 20;

export type ComprehensionRefusal =
  /** The entity declares no id; an ordinal is a position, not an identity. */
  | "no_stable_anchor"
  /** Two attempts, still not a self-contained proposition inside the bound. */
  | "over_length"
  /** A declared dependency does not resolve to any entity in this ontology. */
  | "unresolved_dependency"
  /** The batch's own declarations exceed the window. Never folded. */
  | "batch_oversized"
  | "budget_exhausted"
  /** The annotator failed. `detail` carries the real reason. */
  | "batch_failed";

export interface ComprehensionRefusalCount {
  kind: ComprehensionRefusal;
  count: number;
  /** Present only where a real underlying reason exists. Absent, never `{}`. */
  detail?: string;
}

export interface AnchoredAnnotation {
  anchor: { kind: OntologyEntityAnchorKind; id: string };
  /** The anchored entity's content digest when the annotation was written. */
  anchorDigest: string;
  /** The model's own proposition about what this entity does in this business. */
  role: string;
  /** Other ontology entities this proposition leans on; each must resolve. */
  dependsOn: Array<{ id: string; digest: string }>;
  /** The analysis job that FIRST established it. Carrying an annotation into a
   *  newer ontology version never re-stamps this — the same discipline the
   *  long-term lane applies to a restated claim, applied to inheritance. */
  producedBy: string;
  at: number;
  originHash: string;
}

export interface OntologyComprehensionCoverage {
  /** Entities the ontology declares, of every kind. The honest denominator. */
  anchorsTotal: number;
  annotated: number;
  /** Of `annotated`, how many came from an earlier version unchanged. */
  carriedForward: number;
  refused: ComprehensionRefusalCount[];
}

export interface OntologyComprehensionPack {
  schema: typeof ONTOLOGY_COMPREHENSION_SCHEMA;
  /** Tenancy proof travels INSIDE the value, for the same reason the long-term
   *  lane's envelope does: a store cannot be trusted to prove partitioning. */
  tenantId: string;
  domainId: string;
  ontologyHash: string;
  annotations: AnchoredAnnotation[];
  coverage: OntologyComprehensionCoverage;
}

// ── revalidation ─────────────────────────────────────────────────────────────

export interface OntologyComprehensionRevalidation {
  /** Anchor present and neither it nor any dependency changed. Injectable. */
  intact: AnchoredAnnotation[];
  /** Anchor present but it or a dependency changed. Ids only — see below. */
  moved: AnchoredAnnotation[];
  /** Anchor absent from the current ontology. Withdrawn entirely. */
  gone: AnchoredAnnotation[];
}

/**
 * Sort a stored pack against the CURRENT ontology's anchors.
 *
 * The three states are deliberately not two. "Changed" cannot be merged into
 * "gone" (that throws away the single most useful signal — where the delta is)
 * and cannot be merged into "intact" (that is the silent-reuse failure this
 * whole layer exists to prevent).
 */
export function revalidateOntologyComprehension(
  packOrAnnotations: OntologyComprehensionPack | readonly AnchoredAnnotation[],
  index: OntologyEntityAnchorIndex,
): OntologyComprehensionRevalidation {
  const annotations = Array.isArray(packOrAnnotations)
    ? (packOrAnnotations as readonly AnchoredAnnotation[])
    : (packOrAnnotations as OntologyComprehensionPack).annotations;
  const intact: AnchoredAnnotation[] = [];
  const moved: AnchoredAnnotation[] = [];
  const gone: AnchoredAnnotation[] = [];
  for (const annotation of annotations ?? []) {
    const current = index.anchors.get(annotation.anchor.id);
    if (!current) {
      gone.push(annotation);
      continue;
    }
    const selfChanged = current.digest !== annotation.anchorDigest;
    const dependencyChanged = (annotation.dependsOn ?? []).some((dependency) => {
      const anchored = index.anchors.get(dependency.id);
      return !anchored || anchored.digest !== dependency.digest;
    });
    if (selfChanged || dependencyChanged) moved.push(annotation);
    else intact.push(annotation);
  }
  return { intact, moved, gone };
}

// ── model-visible text ───────────────────────────────────────────────────────

/**
 * Every model-visible string this module can send, as ONE exported constant.
 *
 * Exported so the vocabulary gate scans the exact text that goes over the wire
 * rather than a copy that can drift away from it.
 *
 * Note what is NOT here: any slot for the FDE's question. The understanding pass
 * must produce the same reading of an entity regardless of who is asking, so the
 * question is structurally unavailable to it, not merely discouraged.
 */
export const ONTOLOGY_COMPREHENSION_PROMPT_TEMPLATE = {
  /** Production pass (writing the understanding). */
  produceHeader:
    "下面是域「{domain}」本体中的若干实体声明。请逐个说明：在这套业务里，这个实体承担什么职责、和哪些实体相互依赖。",
  produceRules: [
    "要求：",
    "· 每个实体写一条自洽的陈述句，必须能脱离本次对话单独成立；不要写「见上文」「同上」。",
    "· 只依据下面给出的声明，不要引入声明里没有的实体、字段或系统。",
    "· 每条不超过 {roleChars} 字；写不下就换更概括的说法，不要写半句。",
    "· 依赖只填本体里真实存在的实体 id。",
  ].join("\n"),
  produceEntity: "【{kind} {id}】\n{declaration}",
  produceRewrite:
    "上一轮有 {count} 条超出了 {roleChars} 字上限。请只重写这几条，写成更概括但仍然自洽的陈述句。",

  /** Injection (reading the understanding back into an analysis). */
  intactHeader:
    "【对本体的既有理解 · 由更早的分析建立，这些实体自那以后结构未变】",
  intactLine: "· {kind} {id} —— {role}{deps}",
  intactDeps: "（当时依据：{ids}）",
  movedHeader:
    "【下列实体先前理解过，但其结构此后已变；本次必须重新读取，不得沿用旧理解】",
  goneHeader:
    "【下列先前理解的实体在当前本体中已不存在，相关理解已撤回】",
  idList: "· {ids}",
  idListTruncated: "· {ids}（共 {total} 项）",
  coverage:
    "【覆盖：本体共 {anchorsTotal} 个实体，其中 {annotated} 条有既有理解；本次未理解的 {missing} 条需按需读取】",
  frameTruncated: "（既有理解超出本次可携带的长度，此处只呈现前 {shown} 条，共 {total} 条）",
} as const;

export const ONTOLOGY_COMPREHENSION_ANCHOR_LABELS: Record<OntologyEntityAnchorKind, string> = {
  action: "动作",
  event: "事件",
  object: "对象",
  rule: "规则",
  link: "关系",
};

function fillTemplate(
  template: string,
  vars: Record<string, string | number>,
): string {
  return template.replace(/\{(\w+)\}/gu, (match, key: string) =>
    key in vars ? String(vars[key]) : match,
  );
}

function idLine(ids: string[]): string {
  const template = ONTOLOGY_COMPREHENSION_PROMPT_TEMPLATE;
  const shown = ids.slice(0, ONTOLOGY_COMPREHENSION_IDS_SHOWN);
  return shown.length < ids.length
    ? fillTemplate(template.idListTruncated, { ids: shown.join("、"), total: ids.length })
    : fillTemplate(template.idList, { ids: shown.join("、") });
}

export interface ComprehensionPromptEntity {
  kind: OntologyEntityAnchorKind;
  id: string;
  declaration: string;
}

export interface ComprehensionPromptInput {
  domainId: string;
  entities: readonly ComprehensionPromptEntity[];
  roleChars?: number;
  /** Set on the single rewrite attempt for over-length propositions. */
  rewriteCount?: number;
}

/** Build the production-pass prompt. There is no question parameter, by design
 *  — see the module header. Adding one would be a type error at every call site,
 *  which is the point. */
export function buildComprehensionPrompt(input: ComprehensionPromptInput): string {
  const template = ONTOLOGY_COMPREHENSION_PROMPT_TEMPLATE;
  const roleChars = input.roleChars ?? ONTOLOGY_COMPREHENSION_ROLE_CHARS;
  return [
    fillTemplate(template.produceHeader, { domain: input.domainId }),
    fillTemplate(template.produceRules, { roleChars }),
    ...(input.rewriteCount
      ? [fillTemplate(template.produceRewrite, { count: input.rewriteCount, roleChars })]
      : []),
    "",
    ...input.entities.map((entity) =>
      fillTemplate(template.produceEntity, {
        kind: ONTOLOGY_COMPREHENSION_ANCHOR_LABELS[entity.kind],
        id: entity.id,
        declaration: entity.declaration,
      }),
    ),
  ].join("\n");
}

/**
 * Render the prior understanding for injection.
 *
 * `moved` and `gone` contribute IDS ONLY, never their `role` text. A model
 * cannot tell, inside one paragraph, which sentence describes the current
 * ontology and which describes a version that no longer exists — and it has
 * every incentive to assume it already understands. A bare list of changed ids
 * is strictly more useful anyway: it points the run's limited read budget at the
 * actual delta.
 */
export function renderOntologyComprehension(
  revalidation: OntologyComprehensionRevalidation,
  index: OntologyEntityAnchorIndex,
): string {
  const template = ONTOLOGY_COMPREHENSION_PROMPT_TEMPLATE;
  const { intact, moved, gone } = revalidation;
  if (intact.length === 0 && moved.length === 0 && gone.length === 0) return "";

  const lines: string[] = [];
  let shownIntact = intact.length;
  if (intact.length > 0) {
    lines.push(template.intactHeader);
    for (const annotation of intact) {
      const deps = annotation.dependsOn.length
        ? fillTemplate(template.intactDeps, {
            ids: annotation.dependsOn.map((dependency) => dependency.id).join("、"),
          })
        : "";
      lines.push(
        fillTemplate(template.intactLine, {
          kind: ONTOLOGY_COMPREHENSION_ANCHOR_LABELS[annotation.anchor.kind],
          id: annotation.anchor.id,
          role: annotation.role,
          deps,
        }),
      );
    }
  }
  if (moved.length > 0) {
    lines.push(template.movedHeader);
    lines.push(idLine(moved.map((annotation) => annotation.anchor.id)));
  }
  if (gone.length > 0) {
    lines.push(template.goneHeader);
    lines.push(idLine(gone.map((annotation) => annotation.anchor.id)));
  }
  lines.push(
    fillTemplate(template.coverage, {
      anchorsTotal: index.anchorsTotal,
      annotated: intact.length,
      missing: Math.max(0, index.anchorsTotal - intact.length),
    }),
  );

  let body = lines.join("\n");
  if (body.length > ONTOLOGY_COMPREHENSION_FRAME_CHARS && intact.length > 1) {
    // Drop WHOLE annotations from the tail and say how many exist. A clipped
    // proposition would be unjudgeable, and an unstated drop would be a lie.
    while (body.length > ONTOLOGY_COMPREHENSION_FRAME_CHARS && shownIntact > 1) {
      shownIntact -= 1;
      body = renderOntologyComprehension(
        { ...revalidation, intact: intact.slice(0, shownIntact) },
        index,
      );
    }
    body = [
      body,
      fillTemplate(template.frameTruncated, { shown: shownIntact, total: intact.length }),
    ].join("\n");
  }
  return body;
}

// ── production ───────────────────────────────────────────────────────────────

export interface ComprehensionAnnotatorResult {
  id: string;
  role: string;
  dependsOn?: string[];
}

/** Injected so this module stays pure and fully testable. The api supplies a
 *  gateway-backed implementation; there is no deterministic fallback — an
 *  annotator that cannot run makes the pass FAIL and say so. */
export type ComprehensionAnnotator = (
  batch: readonly ComprehensionPromptEntity[],
  context: { domainId: string; attempt: 1 | 2 },
) => Promise<ComprehensionAnnotatorResult[]>;

export interface ProduceComprehensionInput {
  ontology: DomainOntology;
  ontologyHash: string;
  tenantId: string;
  domainId: string;
  /** The analysis job establishing the NEW annotations of this pass. */
  producedBy: string;
  annotate: ComprehensionAnnotator;
  /** A pack from an earlier ontology version, if one exists. */
  prior?: OntologyComprehensionPack | null;
  budget?: { maxModelCalls?: number };
  batchSize?: number;
  maxBatchChars?: number;
  roleChars?: number;
  now?: number;
}

/** Normalised declaration text handed to the annotator for one entity. */
export function comprehensionDeclaration(
  ontology: DomainOntology,
  kind: OntologyEntityAnchorKind,
  id: string,
): string | null {
  const entity = (() => {
    switch (kind) {
      case "object":
        return (ontology.objects ?? []).find((o) => (o.id || o.name) === id);
      case "action":
        return (ontology.actions ?? []).find((a) => (a.name || a.id) === id);
      case "event":
        return (ontology.events ?? []).find((e) => e.name === id);
      case "rule":
        return (ontology.rules ?? []).find((r) => declaredRuleAnchorId(r) === id);
      case "link":
        return (ontology.links ?? []).find((l) => l.id === id);
    }
  })();
  return entity ? canonicalEvidenceJson(entity) : null;
}

function bumpRefusal(
  refusals: ComprehensionRefusalCount[],
  kind: ComprehensionRefusal,
  count: number,
  detail?: string,
): void {
  const existing = refusals.find(
    (refusal) => refusal.kind === kind && refusal.detail === detail,
  );
  if (existing) existing.count += count;
  else refusals.push({ kind, count, ...(detail ? { detail } : {}) });
}

/**
 * Produce the pack for `ontologyHash`, reusing whatever of `prior` survives
 * revalidation and asking the annotator only about the rest.
 *
 * A PARTIAL pack is persisted deliberately, and the reason differs from the
 * long-term lane's (which refuses to write at all after a fold). Here each
 * annotation is independently anchored and independently checked, so stopping
 * early yields FEWER conclusions — not conclusions drawn without their material.
 * The remainder is reported as a real count, never as silence.
 */
export async function produceOntologyComprehension(
  input: ProduceComprehensionInput,
): Promise<OntologyComprehensionPack> {
  const index = indexOntologyAnchors(input.ontology);
  const now = input.now ?? Date.now();
  const roleChars = input.roleChars ?? ONTOLOGY_COMPREHENSION_ROLE_CHARS;
  const batchSize = input.batchSize ?? ONTOLOGY_COMPREHENSION_BATCH_SIZE;
  const maxBatchChars = input.maxBatchChars ?? ONTOLOGY_COMPREHENSION_BATCH_CHARS;
  const maxModelCalls = input.budget?.maxModelCalls ?? Number.POSITIVE_INFINITY;
  const refused: ComprehensionRefusalCount[] = [];

  // 1. Inherit. `producedBy`/`at`/`originHash` are copied byte-for-byte: an
  //    annotation that survived a version bump was not re-established by this
  //    run, and stamping it would erase the age signal the field exists for.
  const carried = input.prior
    ? revalidateOntologyComprehension(input.prior, index).intact
    : [];
  const annotations: AnchoredAnnotation[] = carried.map((annotation) => ({ ...annotation }));
  const settled = new Set(annotations.map((annotation) => annotation.anchor.id));

  // 2. Everything else needs a fresh reading.
  const anchorless = index.unanchored.reduce((sum, entry) => sum + entry.count, 0);
  if (anchorless > 0) bumpRefusal(refused, "no_stable_anchor", anchorless);

  const pending: ComprehensionPromptEntity[] = [];
  for (const [id, entry] of index.anchors) {
    if (settled.has(id)) continue;
    const declaration = comprehensionDeclaration(input.ontology, entry.kind, id);
    if (declaration === null) continue;
    pending.push({ kind: entry.kind, id, declaration });
  }

  let modelCalls = 0;
  for (let offset = 0; offset < pending.length; offset += batchSize) {
    const batch = pending.slice(offset, offset + batchSize);
    if (modelCalls >= maxModelCalls) {
      bumpRefusal(refused, "budget_exhausted", pending.length - offset);
      break;
    }
    const batchChars = batch.reduce((sum, entity) => sum + entity.declaration.length, 0);
    if (batchChars > maxBatchChars) {
      // Never folded, never clipped: the batch is reported as failed at its
      // real size so the gap is visible rather than silently summarised away.
      bumpRefusal(refused, "batch_oversized", batch.length);
      continue;
    }

    let results: ComprehensionAnnotatorResult[];
    try {
      modelCalls += 1;
      results = await input.annotate(batch, { domainId: input.domainId, attempt: 1 });
    } catch (error) {
      bumpRefusal(
        refused,
        "batch_failed",
        batch.length,
        error instanceof Error ? error.message : String(error),
      );
      continue;
    }

    const byId = new Map(results.map((result) => [result.id, result]));
    const overLength = batch.filter(
      (entity) => (byId.get(entity.id)?.role ?? "").length > roleChars,
    );
    if (overLength.length > 0 && modelCalls < maxModelCalls) {
      try {
        modelCalls += 1;
        const rewritten = await input.annotate(overLength, {
          domainId: input.domainId,
          attempt: 2,
        });
        for (const result of rewritten) byId.set(result.id, result);
      } catch (error) {
        bumpRefusal(
          refused,
          "batch_failed",
          overLength.length,
          error instanceof Error ? error.message : String(error),
        );
      }
    }

    for (const entity of batch) {
      const result = byId.get(entity.id);
      const role = (result?.role ?? "").trim();
      if (!role) {
        bumpRefusal(refused, "batch_failed", 1, "标注结果缺少该实体");
        continue;
      }
      if (role.length > roleChars) {
        bumpRefusal(refused, "over_length", 1);
        continue;
      }
      const dependsOn: AnchoredAnnotation["dependsOn"] = [];
      let unresolved = false;
      for (const dependency of result?.dependsOn ?? []) {
        const anchored = index.anchors.get(dependency);
        if (!anchored) {
          unresolved = true;
          break;
        }
        dependsOn.push({ id: dependency, digest: anchored.digest });
      }
      if (unresolved) {
        bumpRefusal(refused, "unresolved_dependency", 1);
        continue;
      }
      annotations.push({
        anchor: { kind: entity.kind, id: entity.id },
        anchorDigest: index.anchors.get(entity.id)!.digest,
        role,
        dependsOn,
        producedBy: input.producedBy,
        at: now,
        originHash: input.ontologyHash,
      });
    }
  }

  return {
    schema: ONTOLOGY_COMPREHENSION_SCHEMA,
    tenantId: input.tenantId,
    domainId: input.domainId,
    ontologyHash: input.ontologyHash,
    annotations,
    coverage: {
      anchorsTotal: index.anchorsTotal,
      annotated: annotations.length,
      carriedForward: carried.length,
      refused,
    },
  };
}

/**
 * Structural scope check for a pack read back out of storage.
 *
 * The pack is addressed by primary key today, so this is redundant today — and
 * it is here anyway, because the moment an import or cross-domain reuse path
 * exists the check must already be in place rather than being remembered.
 */
export function packMatchesScope(
  pack: OntologyComprehensionPack | null | undefined,
  scope: { tenantId: string; domainId: string; ontologyHash?: string },
): boolean {
  if (!pack || pack.schema !== ONTOLOGY_COMPREHENSION_SCHEMA) return false;
  if (pack.tenantId !== scope.tenantId || pack.domainId !== scope.domainId) return false;
  if (scope.ontologyHash !== undefined && pack.ontologyHash !== scope.ontologyHash) return false;
  return true;
}
