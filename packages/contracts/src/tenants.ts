/**
 * Tenant CRUD contracts (P5-TEN-01).
 *
 * The same Zod schemas validate `POST /v1/tenants` on the API side and parse
 * the response on the SPA side via `/api/spa/bootstrap`. The slug regex and
 * reserved-list are the single source of truth — both client preview and
 * server enforcement read them from here.
 *
 * Slugs are URL-safe, immutable, lowercase, and prefix-restricted so the
 * tenant slug can be embedded in:
 *   - Inngest function IDs (`${tenantSlug}.${agentName}`)
 *   - Event channel names (`${tenantSlug}/${event}`)
 *   - Filesystem paths (`data/logs/${tenantSlug}/...`, `data/tenants/${tenantSlug}/...`)
 *   - HTTP paths (`/v1/tenants/${tenantSlug}/...`)
 *
 * The regex forbids leading digits, leading hyphens/underscores, trailing
 * hyphens, and uppercase letters. Reserved slugs collide with system paths
 * or system tenant rows.
 */

import { z } from "zod";

/** P5-TEN-01 — slug constraint shared between server validation and SPA preview. */
export const TENANT_SLUG_REGEX = /^[a-z][a-z0-9-]{1,31}$/;

/** P5-TEN-01 — refused at the controller layer even if regex passes. */
export const RESERVED_TENANT_SLUGS = new Set<string>([
  "__system",
  "system",
  "admin",
  "root",
  "api",
  "v1",
  "v2",
  "health",
  "metrics",
  "inngest",
  "_meta",
  "static",
  "public",
  "internal",
  "platform",
  "tenants",
  "new",
  "edit",
  "create",
  "delete",
  "archive",
]);

/** Common color regex shared with budgets / settings. */
const HEX_COLOR = /^#[0-9a-f]{6}$/i;

/** P5-TEN-01 — tenant row as returned by the API. */
export const Tenant = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  subtitle: z.string().nullable(),
  color: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
  archivedAt: z.number().nullable(),
  /** Desired manifest-workflow deployment state on this process's Inngest. */
  inngestEnabled: z.boolean(),
});
export type Tenant = z.infer<typeof Tenant>;

/** P5-TEN-01 — list-row decoration: tenant + roll-up counts for the SPA switcher. */
export const TenantListItem = Tenant.extend({
  agentCount: z.number(),
  runs24h: z.number(),
  openTasks: z.number(),
  membership: z.enum(["admin", "operator", "viewer"]).nullable(),
  /** False when AGENTIC_ENABLED_TENANTS assigns this tenant elsewhere. */
  inngestProcessScoped: z.boolean(),
});
export type TenantListItem = z.infer<typeof TenantListItem>;

/** P5-TEN-01 — detail-view payload (single tenant + light aggregates). */
export const TenantDetail = Tenant.extend({
  agentCount: z.number(),
  runs24h: z.number(),
  openTasks: z.number(),
  workflowCount: z.number(),
  deploymentLiveCount: z.number(),
  membership: z.enum(["admin", "operator", "viewer"]).nullable(),
  inngestProcessScoped: z.boolean(),
  budgets: z
    .object({
      monthlyTokenCap: z.number().nullable(),
      monthlyUsdCap: z.number().nullable(),
      usedTokensMonth: z.number(),
      usedUsdMonth: z.number(),
    })
    .nullable(),
});
export type TenantDetail = z.infer<typeof TenantDetail>;

/** P5-TEN-01 — POST /v1/tenants body. */
export const TenantCreateBody = z
  .object({
    slug: z
      .string()
      .min(2)
      .max(32)
      .regex(
        TENANT_SLUG_REGEX,
        "slug must start with a lowercase letter and contain only [a-z0-9-]",
      ),
    name: z.string().min(1).max(64),
    subtitle: z.string().max(128).optional(),
    color: z
      .string()
      .regex(HEX_COLOR, "color must be a 6-digit hex like #d0ff00")
      .optional(),
    /** Initial budgets (null = unlimited). monthlyUsdCap is in integer cents. */
    budget: z
      .object({
        monthlyTokenCap: z.number().int().nonnegative().nullable().optional(),
        monthlyUsdCap: z.number().int().nonnegative().nullable().optional(),
      })
      .optional(),
    /**
     * New domains are deliberately empty. Deploy or import a validated live
     * manifest after creation; the API never invents sample runtime data or
     * claims that a partial metadata clone is executable.
     */
    starter: z.literal("empty").optional().default("empty"),
    /** Issue a fresh bootstrap API token in the response. Default true. */
    mintToken: z.boolean().optional().default(true),
  })
  .superRefine((val, ctx) => {
    if (RESERVED_TENANT_SLUGS.has(val.slug)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["slug"],
        message: `slug "${val.slug}" is reserved`,
      });
    }
  });
export type TenantCreateBody = z.infer<typeof TenantCreateBody>;

/** P5-TEN-01 — PUT /v1/tenants/:slug body. Slug itself is immutable. */
export const TenantUpdateBody = z
  .object({
    name: z.string().min(1).max(64).optional(),
    subtitle: z.string().max(128).nullable().optional(),
    color: z.string().regex(HEX_COLOR).nullable().optional(),
  })
  .strict() // rejects unexpected fields including `slug`
  .refine(
    (val) =>
      val.name !== undefined ||
      val.subtitle !== undefined ||
      val.color !== undefined,
    { message: "at least one of name/subtitle/color is required" },
  );
export type TenantUpdateBody = z.infer<typeof TenantUpdateBody>;

/** P5-TEN-01 — DELETE /v1/tenants/:slug body. `confirm` must equal the slug. */
export const TenantArchiveBody = z.object({
  /**
   * Operator must re-type the slug to confirm. Defends against fat-fingered
   * curl calls and matches the GitHub / Atlassian convention.
   */
  confirm: z.string(),
  reason: z.string().max(512).optional(),
});
export type TenantArchiveBody = z.infer<typeof TenantArchiveBody>;

/** P5-TEN-01 — POST /v1/tenants/:slug/restore body. */
export const TenantRestoreBody = z.object({
  reason: z.string().max(512).optional(),
});
export type TenantRestoreBody = z.infer<typeof TenantRestoreBody>;

/** PUT /v1/tenants/:slug/inngest-deployment body. */
export const TenantInngestDeploymentBody = z
  .object({
    enabled: z.boolean(),
  })
  .strict();
export type TenantInngestDeploymentBody = z.infer<
  typeof TenantInngestDeploymentBody
>;

/** Broker-verified result of changing one tenant's deployment selection. */
export const TenantInngestDeploymentResponse = z.object({
  slug: z.string(),
  enabled: z.boolean(),
  changed: z.boolean(),
  appId: z.string(),
  servePath: z.string(),
  functionCount: z.number().int().nonnegative(),
  status: z.enum(["deployed", "empty", "stopped"]),
  brokerVerified: z.boolean(),
});
export type TenantInngestDeploymentResponse = z.infer<
  typeof TenantInngestDeploymentResponse
>;

/** P5-TEN-01 — POST /v1/tenants response. */
export const TenantCreateResponse = z.object({
  tenant: TenantDetail,
  membership: z.object({
    role: z.enum(["admin", "operator", "viewer"]),
  }),
  /**
   * Bootstrap API token — returned plaintext ONCE, never readable again.
   * The SPA must show this to the operator with a "store before dismissing"
   * confirmation. Null when `mintToken: false` was supplied.
   */
  token: z
    .object({
      id: z.string(),
      name: z.string(),
      plaintext: z.string(),
      scopes: z.array(z.string()),
    })
    .nullable(),
  starter: z.null(),
});
export type TenantCreateResponse = z.infer<typeof TenantCreateResponse>;

/** Validation helper available to both layers. */
export function isReservedSlug(slug: string): boolean {
  if (RESERVED_TENANT_SLUGS.has(slug)) return true;
  if (slug.startsWith("_") || slug.startsWith("-")) return true;
  if (slug.endsWith("-")) return true;
  return false;
}
