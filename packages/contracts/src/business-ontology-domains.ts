import { z } from "zod";
import { RuntimeProfileVersionSchema } from "./runtime-profiles";

const IdentifierSchema = z.string().trim().min(1).max(160);
const TimestampSchema = z.number().int().nonnegative();
const Sha256Schema = z
  .string()
  .trim()
  .regex(/^(?:sha256:)?[a-f0-9]{64}$/);
const JsonObjectSchema = z.record(z.string(), z.unknown());

export const BusinessOntologyDomainSourceSchema = z.enum([
  "allmeta",
  "upload",
  "manifest_legacy",
]);
export type BusinessOntologyDomainSource = z.infer<
  typeof BusinessOntologyDomainSourceSchema
>;

export const BusinessOntologyDomainStatusSchema = z.enum([
  "active",
  "unavailable",
  "archived",
]);
export type BusinessOntologyDomainStatus = z.infer<
  typeof BusinessOntologyDomainStatusSchema
>;

export const RuntimeBindingModeSchema = z.enum([
  "legacy_native",
  "profile_pinned",
]);
export type RuntimeBindingMode = z.infer<typeof RuntimeBindingModeSchema>;

export const RuntimeExecutionReadinessSchema = z
  .object({
    state: z.enum([
      "legacy_compatible",
      "configuration_required",
      "ready",
      "adapter_resolver_required",
      "profile_archived",
      "invalid",
    ]),
    code: z.string().trim().min(1).max(160),
    message: z.string().trim().min(1).max(1_000),
    executable: z.boolean(),
  })
  .strict();
export type RuntimeExecutionReadiness = z.infer<
  typeof RuntimeExecutionReadinessSchema
>;

/**
 * One exact Ontology Domain registered under a tenant-scoped Business Domain.
 * `ontologyDomainId` is the canonical Allmeta/upload identity and is never
 * inferred from the Business Domain slug or display name.
 */
export const BusinessOntologyDomainSchema = z
  .object({
    id: IdentifierSchema,
    tenantId: IdentifierSchema,
    runtimeProfileVersionId: IdentifierSchema.nullable(),
    runtimeBindingMode: RuntimeBindingModeSchema,
    runtimeProfileVersion: RuntimeProfileVersionSchema.nullable(),
    executionReadiness: RuntimeExecutionReadinessSchema,
    ontologyDomainId: z.string().trim().min(1).max(160),
    displayName: z.string().trim().min(1).max(200),
    source: BusinessOntologyDomainSourceSchema,
    status: BusinessOntologyDomainStatusSchema,
    isDefault: z.boolean(),
    ontologySnapshotHash: Sha256Schema.nullable(),
    catalogMetadata: JsonObjectSchema,
    lastVerifiedAt: TimestampSchema.nullable(),
    lastError: z.string().trim().min(1).max(2_000).nullable(),
    createdBy: IdentifierSchema.nullable(),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
    archivedAt: TimestampSchema.nullable(),
  })
  .strict();
export type BusinessOntologyDomain = z.infer<
  typeof BusinessOntologyDomainSchema
>;

export const BusinessOntologyDomainCatalogItemSchema = z
  .object({
    ontologyDomainId: z.string().trim().min(1).max(160),
    displayName: z.string().trim().min(1).max(200),
    source: z.literal("allmeta"),
    counts: z.record(z.string(), z.number().int().nonnegative()).default({}),
    registrationId: IdentifierSchema.nullable(),
    registrationStatus: BusinessOntologyDomainStatusSchema.nullable(),
  })
  .strict();
export type BusinessOntologyDomainCatalogItem = z.infer<
  typeof BusinessOntologyDomainCatalogItemSchema
>;

export const ListBusinessOntologyDomainsQuerySchema = z
  .object({
    includeArchived: z.coerce.boolean().default(false),
    includeUnavailable: z.coerce.boolean().default(true),
  })
  .strict();

export const CreateBusinessOntologyDomainRequestSchema = z
  .object({
    ontologyDomainId: z.string().trim().min(1).max(160),
    source: z.enum(["allmeta", "upload"]).default("allmeta"),
    displayName: z.string().trim().min(1).max(200).optional(),
    makeDefault: z.boolean().default(false),
    runtimeProfileVersionId: IdentifierSchema.optional(),
  })
  .strict();
export type CreateBusinessOntologyDomainRequest = z.infer<
  typeof CreateBusinessOntologyDomainRequestSchema
>;

export const UpdateBusinessOntologyDomainRequestSchema = z
  .object({
    displayName: z.string().trim().min(1).max(200).optional(),
    makeDefault: z.literal(true).optional(),
  })
  .strict()
  .refine(
    (input) =>
      input.displayName !== undefined || input.makeDefault !== undefined,
    "at least one mutable field is required",
  );
export type UpdateBusinessOntologyDomainRequest = z.infer<
  typeof UpdateBusinessOntologyDomainRequestSchema
>;

export const ArchiveBusinessOntologyDomainRequestSchema = z
  .object({
    confirmOntologyDomainId: z.string().trim().min(1).max(160),
  })
  .strict();
export type ArchiveBusinessOntologyDomainRequest = z.infer<
  typeof ArchiveBusinessOntologyDomainRequestSchema
>;

export const BusinessOntologyDomainListReceiptSchema = z
  .object({
    items: z.array(BusinessOntologyDomainSchema),
    count: z.number().int().nonnegative(),
  })
  .strict();

export const BusinessOntologyDomainCatalogReceiptSchema = z
  .object({
    items: z.array(BusinessOntologyDomainCatalogItemSchema),
    count: z.number().int().nonnegative(),
    catalogError: z.string().nullable(),
  })
  .strict();

export const BusinessOntologyDomainMutationReceiptSchema = z
  .object({
    domain: BusinessOntologyDomainSchema,
    mode: z.enum([
      "created",
      "attached",
      "updated",
      "verified",
      "runtime_bound",
      "archived",
    ]),
  })
  .strict();

/**
 * Stable, UI-safe projection of an authoritative Ontology Action. The
 * registration id selects the transport; action ids are the exact ids callers
 * pass back when creating an OntoCode selected-actions scope.
 */
export const BusinessOntologyDomainActionSchema = z
  .object({
    id: IdentifierSchema,
    name: IdentifierSchema,
    description: z.string().nullable(),
    category: z.string().nullable(),
    actor: z.array(z.string()),
    trigger: z.array(z.string()),
    triggeredEvent: z.array(z.string()),
    targetObjects: z.array(z.string()),
    toolUse: z.array(z.string()),
  })
  .strict();
export type BusinessOntologyDomainAction = z.infer<
  typeof BusinessOntologyDomainActionSchema
>;

export const BusinessOntologyDomainOntologyReceiptSchema = z
  .object({
    registration: BusinessOntologyDomainSchema,
    ontology: z
      .object({
        domainId: z.string().trim().min(1).max(160),
        authoritativeSource: z.enum(["allmeta", "upload"]),
        normalizedSource: z.enum(["allmeta", "snapshot"]),
        snapshotHash: Sha256Schema,
        registeredSnapshotHash: Sha256Schema.nullable(),
        snapshotMatchesRegistration: z.boolean(),
        counts: z
          .object({
            actions: z.number().int().nonnegative(),
            events: z.number().int().nonnegative(),
            objects: z.number().int().nonnegative(),
            rules: z.number().int().nonnegative(),
            links: z.number().int().nonnegative(),
            workflow: z.number().int().nonnegative(),
          })
          .strict(),
        actions: z.array(BusinessOntologyDomainActionSchema),
        fetchedAt: TimestampSchema,
      })
      .strict(),
  })
  .strict();
export type BusinessOntologyDomainOntologyReceipt = z.infer<
  typeof BusinessOntologyDomainOntologyReceiptSchema
>;
