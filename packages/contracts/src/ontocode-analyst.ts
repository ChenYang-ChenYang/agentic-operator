import { z } from "zod";

/**
 * Hard transport limits for the OntoCode Ontology Analyst presentation.
 *
 * These limits are part of the protocol, not merely renderer preferences:
 * persisted artifacts and API responses must stay bounded even when a source
 * contains a very large Ontology. Clients may apply tighter defensive caps.
 */
export const ONTOCODE_ANALYST_PRESENTATION_LIMITS = {
  blocks: 40,
  metricItems: 24,
  tableColumns: 24,
  tableRows: 100,
  listItems: 80,
  listRefs: 24,
  relationshipNodes: 80,
  relationshipEdges: 120,
  cellTags: 12,
  focus: 8,
  preferredViews: 4,
} as const;

const NonEmptyTextSchema = (max: number) => z.string().trim().min(1).max(max);
const IdentifierSchema = NonEmptyTextSchema(200);
const BlockTitleSchema = NonEmptyTextSchema(500);
const CellTextSchema = z.string().max(320);
const CountSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

/**
 * Table cells never accept nested objects or arbitrary JSON. A tags cell is
 * the sole collection form and is itself bounded.
 */
export const OntoCodeAnalystScalarCellSchema = z.union([
  CellTextSchema,
  z.number().finite(),
  z.boolean(),
  z.null(),
]);
export type OntoCodeAnalystScalarCell = z.infer<
  typeof OntoCodeAnalystScalarCellSchema
>;

export const OntoCodeAnalystCellSchema = z.union([
  OntoCodeAnalystScalarCellSchema,
  z.array(CellTextSchema).max(ONTOCODE_ANALYST_PRESENTATION_LIMITS.cellTags),
]);
export type OntoCodeAnalystCell = z.infer<typeof OntoCodeAnalystCellSchema>;

export const OntoCodeAnalystEvidenceSchema = z.enum([
  "ontology_structure",
  "live_probe",
  "verified_interpretation",
]);
export type OntoCodeAnalystEvidence = z.infer<
  typeof OntoCodeAnalystEvidenceSchema
>;

export const OntoCodeAnalystBlockKindSchema = z.enum([
  "metrics",
  "table",
  "list",
  "relationship",
]);
export type OntoCodeAnalystBlockKind = z.infer<
  typeof OntoCodeAnalystBlockKindSchema
>;

const BlockBaseShape = {
  id: IdentifierSchema,
  title: BlockTitleSchema,
  description: z.string().max(2_000).optional(),
  evidence: z.array(OntoCodeAnalystEvidenceSchema).max(3),
};

export const OntoCodeAnalystMetricsBlockSchema = z
  .object({
    ...BlockBaseShape,
    kind: z.literal("metrics"),
    items: z
      .array(
        z
          .object({
            id: IdentifierSchema,
            label: NonEmptyTextSchema(200),
            value: z.union([CellTextSchema, z.number().finite()]),
            unit: z.string().max(40).optional(),
            tone: z
              .enum(["neutral", "positive", "warning", "critical"])
              .optional(),
            detail: z.string().max(1_000).optional(),
          })
          .strict(),
      )
      .max(ONTOCODE_ANALYST_PRESENTATION_LIMITS.metricItems),
  })
  .strict();
export type OntoCodeAnalystMetricsBlock = z.infer<
  typeof OntoCodeAnalystMetricsBlockSchema
>;

export const OntoCodeAnalystTableColumnSchema = z
  .object({
    key: NonEmptyTextSchema(120),
    label: NonEmptyTextSchema(200),
    dataType: z.enum(["text", "number", "boolean", "tags", "status"]),
  })
  .strict();
export type OntoCodeAnalystTableColumn = z.infer<
  typeof OntoCodeAnalystTableColumnSchema
>;

const OntoCodeAnalystTableRowSchema = z.record(
  z.string().trim().min(1).max(120),
  OntoCodeAnalystCellSchema,
);

export const OntoCodeAnalystTableBlockSchema = z
  .object({
    ...BlockBaseShape,
    kind: z.literal("table"),
    columns: z
      .array(OntoCodeAnalystTableColumnSchema)
      .min(1)
      .max(ONTOCODE_ANALYST_PRESENTATION_LIMITS.tableColumns),
    rows: z
      .array(OntoCodeAnalystTableRowSchema)
      .max(ONTOCODE_ANALYST_PRESENTATION_LIMITS.tableRows),
    totalRows: CountSchema,
    truncated: z.boolean(),
  })
  .strict()
  .superRefine((block, ctx) => {
    const columnKeys = new Set(block.columns.map((column) => column.key));
    if (columnKeys.size !== block.columns.length) {
      ctx.addIssue({
        code: "custom",
        path: ["columns"],
        message: "table column keys must be unique",
      });
    }
    block.rows.forEach((row, rowIndex) => {
      for (const key of Object.keys(row)) {
        if (!columnKeys.has(key)) {
          ctx.addIssue({
            code: "custom",
            path: ["rows", rowIndex, key],
            message: "table row keys must be declared by columns",
          });
        }
      }
    });
    if (block.totalRows < block.rows.length) {
      ctx.addIssue({
        code: "custom",
        path: ["totalRows"],
        message: "totalRows cannot be smaller than the rendered row count",
      });
    }
  });
export type OntoCodeAnalystTableBlock = z.infer<
  typeof OntoCodeAnalystTableBlockSchema
>;

export const OntoCodeAnalystListBlockSchema = z
  .object({
    ...BlockBaseShape,
    kind: z.literal("list"),
    items: z
      .array(
        z
          .object({
            id: IdentifierSchema,
            title: NonEmptyTextSchema(500),
            detail: z.string().max(1_000).optional(),
            severity: z.enum(["info", "warning", "critical"]).optional(),
            refs: z
              .array(NonEmptyTextSchema(200))
              .max(ONTOCODE_ANALYST_PRESENTATION_LIMITS.listRefs)
              .optional(),
          })
          .strict(),
      )
      .max(ONTOCODE_ANALYST_PRESENTATION_LIMITS.listItems),
    totalItems: CountSchema,
    truncated: z.boolean(),
  })
  .strict()
  .superRefine((block, ctx) => {
    if (block.totalItems < block.items.length) {
      ctx.addIssue({
        code: "custom",
        path: ["totalItems"],
        message: "totalItems cannot be smaller than the rendered item count",
      });
    }
  });
export type OntoCodeAnalystListBlock = z.infer<
  typeof OntoCodeAnalystListBlockSchema
>;

export const OntoCodeAnalystRelationshipBlockSchema = z
  .object({
    ...BlockBaseShape,
    kind: z.literal("relationship"),
    nodes: z
      .array(
        z
          .object({
            id: IdentifierSchema,
            label: NonEmptyTextSchema(200),
            entityType: NonEmptyTextSchema(120),
          })
          .strict(),
      )
      .max(ONTOCODE_ANALYST_PRESENTATION_LIMITS.relationshipNodes),
    edges: z
      .array(
        z
          .object({
            id: IdentifierSchema,
            source: IdentifierSchema,
            target: IdentifierSchema,
            label: NonEmptyTextSchema(200),
          })
          .strict(),
      )
      .max(ONTOCODE_ANALYST_PRESENTATION_LIMITS.relationshipEdges),
    totalNodes: CountSchema,
    totalEdges: CountSchema,
    truncated: z.boolean(),
  })
  .strict()
  .superRefine((block, ctx) => {
    const nodeIds = new Set(block.nodes.map((node) => node.id));
    if (nodeIds.size !== block.nodes.length) {
      ctx.addIssue({
        code: "custom",
        path: ["nodes"],
        message: "relationship node ids must be unique",
      });
    }
    block.edges.forEach((edge, edgeIndex) => {
      if (!nodeIds.has(edge.source)) {
        ctx.addIssue({
          code: "custom",
          path: ["edges", edgeIndex, "source"],
          message: "relationship edge source must reference a rendered node",
        });
      }
      if (!nodeIds.has(edge.target)) {
        ctx.addIssue({
          code: "custom",
          path: ["edges", edgeIndex, "target"],
          message: "relationship edge target must reference a rendered node",
        });
      }
    });
    if (block.totalNodes < block.nodes.length) {
      ctx.addIssue({
        code: "custom",
        path: ["totalNodes"],
        message: "totalNodes cannot be smaller than the rendered node count",
      });
    }
    if (block.totalEdges < block.edges.length) {
      ctx.addIssue({
        code: "custom",
        path: ["totalEdges"],
        message: "totalEdges cannot be smaller than the rendered edge count",
      });
    }
  });
export type OntoCodeAnalystRelationshipBlock = z.infer<
  typeof OntoCodeAnalystRelationshipBlockSchema
>;

export const OntoCodeAnalystBlockSchema = z.discriminatedUnion("kind", [
  OntoCodeAnalystMetricsBlockSchema,
  OntoCodeAnalystTableBlockSchema,
  OntoCodeAnalystListBlockSchema,
  OntoCodeAnalystRelationshipBlockSchema,
]);
export type OntoCodeAnalystBlock = z.infer<typeof OntoCodeAnalystBlockSchema>;

export const OntoCodeAnalystPresentationV1Schema = z
  .object({
    schema: z.literal("ontocode-analysis-presentation/v1"),
    domain: NonEmptyTextSchema(160),
    title: NonEmptyTextSchema(240),
    request: z
      .object({
        question: z.string().max(1_000).nullable(),
        focus: z
          .array(NonEmptyTextSchema(160))
          .max(ONTOCODE_ANALYST_PRESENTATION_LIMITS.focus),
        preferredViews: z
          .array(OntoCodeAnalystBlockKindSchema)
          .max(ONTOCODE_ANALYST_PRESENTATION_LIMITS.preferredViews),
      })
      .strict(),
    blocks: z
      .array(OntoCodeAnalystBlockSchema)
      .max(ONTOCODE_ANALYST_PRESENTATION_LIMITS.blocks),
  })
  .strict();
export type OntoCodeAnalystPresentationV1 = z.infer<
  typeof OntoCodeAnalystPresentationV1Schema
>;
