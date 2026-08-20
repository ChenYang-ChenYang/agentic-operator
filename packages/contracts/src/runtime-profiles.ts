import { z } from "zod";

const IdentifierSchema = z.string().trim().min(1).max(160);
const TimestampSchema = z.number().int().nonnegative();

export const RuntimeProfileStatusSchema = z.enum(["active", "archived"]);
export type RuntimeProfileStatus = z.infer<typeof RuntimeProfileStatusSchema>;

export const RuntimeAdapterKindSchema = z.enum([
  "native",
  "tenant_registry_compat",
]);
export type RuntimeAdapterKind = z.infer<typeof RuntimeAdapterKindSchema>;

/**
 * Public, secret-free coordinates of one immutable execution adapter.
 *
 * `adapterRegistrySlug` selects reviewed code only. It is never an
 * authorization, data, Integration, credential, log, or filesystem scope.
 * Those scopes always remain the owning Business Domain tenant.
 */
export const RuntimeAdapterCoordinatesSchema = z
  .object({
    kind: RuntimeAdapterKindSchema,
    adapterRegistrySlug: z
      .string()
      .trim()
      .regex(/^[a-z][a-z0-9-]{1,63}$/),
    adapterRegistryVersion: z.string().trim().min(1).max(160),
    eventNamespace: z.string().trim().min(1).max(160),
    compatibilityTenantSlug: z
      .string()
      .trim()
      .regex(/^[a-z][a-z0-9-]{1,63}$/)
      .nullable()
      .default(null),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      value.kind === "tenant_registry_compat" &&
      value.compatibilityTenantSlug === null
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["compatibilityTenantSlug"],
        message:
          "tenant_registry_compat requires an explicit compatibility tenant",
      });
    }
    if (value.kind === "native" && value.compatibilityTenantSlug !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["compatibilityTenantSlug"],
        message: "native adapters cannot reference a compatibility tenant",
      });
    }
  });
export type RuntimeAdapterCoordinates = z.infer<
  typeof RuntimeAdapterCoordinatesSchema
>;

export const RuntimeProfileSchema = z
  .object({
    id: IdentifierSchema,
    tenantId: IdentifierSchema,
    name: z.string().trim().min(1).max(160),
    description: z.string().trim().max(2_000).nullable(),
    status: RuntimeProfileStatusSchema,
    createdBy: IdentifierSchema.nullable(),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
    archivedAt: TimestampSchema.nullable(),
  })
  .strict();
export type RuntimeProfile = z.infer<typeof RuntimeProfileSchema>;

export const RuntimeProfileVersionSchema = z
  .object({
    id: IdentifierSchema,
    profileId: IdentifierSchema,
    tenantId: IdentifierSchema,
    version: z.number().int().positive(),
    adapter: RuntimeAdapterCoordinatesSchema,
    compatibilityTenantId: IdentifierSchema.nullable(),
    /**
     * Deliberately constant. A compatibility adapter may reuse reviewed
     * handlers/event transforms, but never the referenced tenant's secrets.
     */
    credentialScope: z.literal("business_domain"),
    createdBy: IdentifierSchema.nullable(),
    createdAt: TimestampSchema,
  })
  .strict();
export type RuntimeProfileVersion = z.infer<
  typeof RuntimeProfileVersionSchema
>;

export const RuntimeProfileWithVersionsSchema = z
  .object({
    profile: RuntimeProfileSchema,
    versions: z.array(RuntimeProfileVersionSchema),
  })
  .strict();

export const CreateRuntimeProfileRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(160),
    description: z.string().trim().max(2_000).optional(),
    adapter: RuntimeAdapterCoordinatesSchema,
  })
  .strict();
export type CreateRuntimeProfileRequest = z.infer<
  typeof CreateRuntimeProfileRequestSchema
>;

export const CreateRuntimeProfileVersionRequestSchema = z
  .object({
    adapter: RuntimeAdapterCoordinatesSchema,
  })
  .strict();
export type CreateRuntimeProfileVersionRequest = z.infer<
  typeof CreateRuntimeProfileVersionRequestSchema
>;

export const ArchiveRuntimeProfileRequestSchema = z
  .object({
    confirmName: z.string().trim().min(1).max(160),
  })
  .strict();

export const ListRuntimeProfilesQuerySchema = z
  .object({
    includeArchived: z.coerce.boolean().default(false),
  })
  .strict();

export const RuntimeProfileListReceiptSchema = z
  .object({
    items: z.array(RuntimeProfileWithVersionsSchema),
    count: z.number().int().nonnegative(),
  })
  .strict();

export const RuntimeProfileMutationReceiptSchema = z
  .object({
    profile: RuntimeProfileSchema,
    version: RuntimeProfileVersionSchema.nullable(),
    mode: z.enum(["created", "version_created", "archived"]),
  })
  .strict();

export const BindBusinessOntologyDomainRuntimeProfileRequestSchema = z
  .object({
    runtimeProfileVersionId: IdentifierSchema,
  })
  .strict();
export type BindBusinessOntologyDomainRuntimeProfileRequest = z.infer<
  typeof BindBusinessOntologyDomainRuntimeProfileRequestSchema
>;

/**
 * Idempotent control-plane bootstrap for the canonical Recruitment Business
 * Domain. The Business Domain must already exist so normal tenant provisioning
 * remains the only place that creates memberships, budgets and credentials.
 */
export const BootstrapRecruitmentRuntimeProfilesRequestSchema = z
  .object({
    businessDomainSlug: z
      .string()
      .trim()
      .regex(/^[a-z][a-z0-9-]{1,31}$/)
      .default("recruitment"),
    registrations: z
      .array(
        z
          .object({
            ontologyDomainId: z.string().trim().min(1).max(160),
            displayName: z.string().trim().min(1).max(200).optional(),
            profileName: z.string().trim().min(1).max(160),
            adapter: RuntimeAdapterCoordinatesSchema.refine(
              (value) => value.kind === "tenant_registry_compat",
              "canonical bootstrap adapters must be explicit compatibility references",
            ),
          })
          .strict(),
      )
      .min(1)
      .max(20),
  })
  .strict();
export type BootstrapRecruitmentRuntimeProfilesRequest = z.infer<
  typeof BootstrapRecruitmentRuntimeProfilesRequestSchema
>;

export const BootstrapRecruitmentRuntimeProfilesReceiptSchema = z
  .object({
    businessDomainTenantId: IdentifierSchema,
    businessDomainSlug: z.string(),
    credentialScope: z.literal("business_domain"),
    items: z.array(
      z
        .object({
          ontologyDomainRegistrationId: IdentifierSchema,
          ontologyDomainId: z.string(),
          runtimeProfileId: IdentifierSchema,
          runtimeProfileVersionId: IdentifierSchema,
          executionState: z.literal("adapter_resolver_required"),
        })
        .strict(),
    ),
  })
  .strict();
