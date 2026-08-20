// #ONTOCODE-COMPREHEND — persistence for the ontology understanding layer.
//
// Addressed by primary key `(tenant_id, domain, ontology_hash)`, so a version
// bump MISSES rather than serving a stale reading. That is the whole invalidation
// strategy: there is no eviction job to forget to run, and no TTL to guess.
//
// Two deliberate choices worth stating:
//
//   · The pack handed back to callers is stamped with the CALLER's scope, never
//     with a tenant/domain lifted out of stored JSON. Stored JSON is data; the
//     query's scope is the authority. This makes it structurally impossible for
//     a doctored row to widen its own reach.
//   · Annotations that fail to parse are DROPPED WITH A COUNT, not repaired.
//     A half-decoded annotation would be a proposition whose anchor cannot be
//     re-checked, which is the one thing this layer must never contain.

import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { getDb, ontocodeOntologyComprehension, tenantScope } from "@agentic/db";
import {
  ONTOLOGY_COMPREHENSION_SCHEMA,
  type AnchoredAnnotation,
  type ComprehensionRefusalCount,
  type OntologyComprehensionPack,
} from "@agentic/agent-factory";

const ANCHOR_KINDS = new Set(["action", "event", "object", "rule", "link"]);

/** Strict decode of one stored annotation. Anything incomplete returns `null`
 *  and is counted by the caller, never patched with a default. */
function decodeAnnotation(raw: unknown): AnchoredAnnotation | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  const anchor = value.anchor as Record<string, unknown> | undefined;
  const text = (field: unknown): string | null =>
    typeof field === "string" && field.trim().length > 0 ? field.trim() : null;
  const kind = text(anchor?.kind);
  const id = text(anchor?.id);
  const anchorDigest = text(value.anchorDigest);
  const role = text(value.role);
  const producedBy = text(value.producedBy);
  const originHash = text(value.originHash);
  const at = typeof value.at === "number" && Number.isFinite(value.at) ? value.at : null;
  if (!kind || !ANCHOR_KINDS.has(kind)) return null;
  if (!id || !anchorDigest || !role || !producedBy || !originHash || at === null) return null;
  const dependsOn: AnchoredAnnotation["dependsOn"] = [];
  if (Array.isArray(value.dependsOn)) {
    for (const entry of value.dependsOn) {
      if (!entry || typeof entry !== "object") continue;
      const dependency = entry as Record<string, unknown>;
      const dependencyId = text(dependency.id);
      const digest = text(dependency.digest);
      // A dependency without its digest cannot be re-checked, so the whole
      // annotation is refused rather than silently becoming un-invalidatable.
      if (!dependencyId || !digest) return null;
      dependsOn.push({ id: dependencyId, digest });
    }
  }
  return {
    anchor: { kind: kind as AnchoredAnnotation["anchor"]["kind"], id },
    anchorDigest,
    role,
    dependsOn,
    producedBy,
    at,
    originHash,
  };
}

function decodeCoverage(raw: unknown): OntologyComprehensionPack["coverage"] {
  const value = (raw ?? {}) as Record<string, unknown>;
  const num = (field: unknown): number =>
    typeof field === "number" && Number.isFinite(field) ? field : 0;
  const refused: ComprehensionRefusalCount[] = Array.isArray(value.refused)
    ? (value.refused as unknown[]).flatMap((entry) => {
        if (!entry || typeof entry !== "object") return [];
        const row = entry as Record<string, unknown>;
        if (typeof row.kind !== "string") return [];
        return [
          {
            kind: row.kind as ComprehensionRefusalCount["kind"],
            count: num(row.count),
            ...(typeof row.detail === "string" && row.detail
              ? { detail: row.detail }
              : {}),
          },
        ];
      })
    : [];
  return {
    anchorsTotal: num(value.anchorsTotal),
    annotated: num(value.annotated),
    carriedForward: num(value.carriedForward),
    refused,
  };
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function rowToPack(
  row: {
    domain: string;
    ontologyHash: string;
    annotationsJson: string;
    coverageJson: string;
  },
  scope: { tenantId: string },
): OntologyComprehensionPack {
  const parsed = parseJson(row.annotationsJson);
  const rawAnnotations = Array.isArray(parsed) ? parsed : [];
  const annotations: AnchoredAnnotation[] = [];
  let undecodable = 0;
  for (const entry of rawAnnotations) {
    const annotation = decodeAnnotation(entry);
    if (annotation) annotations.push(annotation);
    else undecodable += 1;
  }
  const coverage = decodeCoverage(parseJson(row.coverageJson));
  return {
    schema: ONTOLOGY_COMPREHENSION_SCHEMA,
    // Scope comes from the QUERY, never from stored JSON.
    tenantId: scope.tenantId,
    domainId: row.domain,
    ontologyHash: row.ontologyHash,
    annotations,
    coverage: {
      ...coverage,
      annotated: annotations.length,
      // A row that lost annotations to a decode failure says so, with the real
      // count, instead of quietly reporting a smaller understanding.
      refused:
        undecodable > 0
          ? [
              ...coverage.refused,
              { kind: "batch_failed", count: undecodable, detail: "存储中的注释无法解析" },
            ]
          : coverage.refused,
    },
  };
}

/** Exact read. A different ontology version MISSES — that is the invalidation. */
export async function readOntologyComprehension(
  ctx: { tenantId: string },
  domain: string,
  ontologyHash: string,
): Promise<OntologyComprehensionPack | null> {
  if (!domain.trim() || !ontologyHash.trim()) return null;
  const row = getDb()
    .select()
    .from(ontocodeOntologyComprehension)
    .where(
      tenantScope(
        ctx,
        ontocodeOntologyComprehension,
      )(
        and(
          eq(ontocodeOntologyComprehension.domain, domain),
          eq(ontocodeOntologyComprehension.ontologyHash, ontologyHash),
        ),
      ),
    )
    .get();
  return row ? rowToPack(row, ctx) : null;
}

/**
 * The newest pack for a domain, whatever version it describes.
 *
 * This is the INHERITANCE BASE, not a fallback answer: its annotations are
 * re-validated anchor by anchor against the current ontology before any of them
 * is reused, so an older version can contribute only the parts that provably did
 * not change. It is never rendered to a model directly.
 */
export async function readLatestOntologyComprehension(
  ctx: { tenantId: string },
  domain: string,
): Promise<OntologyComprehensionPack | null> {
  if (!domain.trim()) return null;
  const row = getDb()
    .select()
    .from(ontocodeOntologyComprehension)
    .where(
      tenantScope(
        ctx,
        ontocodeOntologyComprehension,
      )(eq(ontocodeOntologyComprehension.domain, domain)),
    )
    .orderBy(desc(ontocodeOntologyComprehension.producedAt))
    .get();
  return row ? rowToPack(row, ctx) : null;
}

/** Upsert one ontology version's understanding. */
export async function writeOntologyComprehension(
  ctx: { tenantId: string },
  pack: OntologyComprehensionPack,
  sourceJobId: string | null,
): Promise<void> {
  const now = new Date();
  getDb()
    .insert(ontocodeOntologyComprehension)
    .values({
      id: `occ-${randomUUID().slice(0, 12)}`,
      tenantId: ctx.tenantId,
      domain: pack.domainId,
      ontologyHash: pack.ontologyHash,
      sourceJobId,
      producedAt: now,
      schemaVersion: pack.schema,
      annotationsJson: JSON.stringify(pack.annotations),
      coverageJson: JSON.stringify(pack.coverage),
      createdAt: now,
      updatedAt: now,
    } as typeof ontocodeOntologyComprehension.$inferInsert)
    .onConflictDoUpdate({
      target: [
        ontocodeOntologyComprehension.tenantId,
        ontocodeOntologyComprehension.domain,
        ontocodeOntologyComprehension.ontologyHash,
      ],
      set: {
        sourceJobId,
        producedAt: now,
        schemaVersion: pack.schema,
        annotationsJson: JSON.stringify(pack.annotations),
        coverageJson: JSON.stringify(pack.coverage),
        updatedAt: now,
      },
    })
    .run();
}

/**
 * Withdraw an understanding on the FDE's instruction.
 *
 * The layer contains no conversation content, so a Session delete has no reason
 * to touch it — but an FDE who thinks the model read the domain wrong must still
 * be able to make it forget. Domain-wide, or one anchor at a time.
 */
export async function forgetOntologyComprehension(
  ctx: { tenantId: string },
  domain: string,
  anchorId?: string,
): Promise<number> {
  if (!domain.trim()) return 0;
  const rows = getDb()
    .select()
    .from(ontocodeOntologyComprehension)
    .where(
      tenantScope(
        ctx,
        ontocodeOntologyComprehension,
      )(eq(ontocodeOntologyComprehension.domain, domain)),
    )
    .all();
  if (rows.length === 0) return 0;
  if (!anchorId) {
    getDb()
      .delete(ontocodeOntologyComprehension)
      .where(
        tenantScope(
          ctx,
          ontocodeOntologyComprehension,
        )(eq(ontocodeOntologyComprehension.domain, domain)),
      )
      .run();
    return rows.length;
  }
  let touched = 0;
  for (const row of rows) {
    const pack = rowToPack(row, ctx);
    const kept = pack.annotations.filter(
      (annotation) => annotation.anchor.id !== anchorId,
    );
    if (kept.length === pack.annotations.length) continue;
    touched += 1;
    getDb()
      .update(ontocodeOntologyComprehension)
      .set({
        annotationsJson: JSON.stringify(kept),
        coverageJson: JSON.stringify({ ...pack.coverage, annotated: kept.length }),
        updatedAt: new Date(),
      })
      .where(eq(ontocodeOntologyComprehension.id, row.id))
      .run();
  }
  return touched;
}
