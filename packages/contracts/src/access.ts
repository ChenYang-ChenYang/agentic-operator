/**
 * @agentic/contracts/access — auth + identity + membership wire schemas.
 *
 * Used by the api routes in apps/api/src/routes/v1/{auth,members,admin-users}.ts
 * and parsed on the web side by the hooks in apps/web/lib/hooks/useAuth.ts /
 * useAccess.ts.
 */

import { z } from "zod";
import {
  PermissionSchema,
  PlatformRoleSchema,
  TenantRoleSchema,
} from "./permissions";

// ─── Auth bodies ─────────────────────────────────────────────────────────────

export const PASSWORD_MIN = 8;

export const RegisterBody = z.object({
  email: z.string().email(),
  password: z.string().min(PASSWORD_MIN, `password must be ≥ ${PASSWORD_MIN} chars`),
  name: z.string().trim().min(1).max(120),
});
export type RegisterBody = z.infer<typeof RegisterBody>;

export const LoginBody = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  /** Optional active-tenant hint for the post-login redirect. */
  tenant: z.string().min(1).max(64).optional(),
});
export type LoginBody = z.infer<typeof LoginBody>;

export const ChangePasswordBody = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(PASSWORD_MIN, `password must be ≥ ${PASSWORD_MIN} chars`),
});
export type ChangePasswordBody = z.infer<typeof ChangePasswordBody>;

// ─── Identity (GET /v1/me) ───────────────────────────────────────────────────

export const MeUser = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string(),
  platformRole: PlatformRoleSchema,
});
export type MeUser = z.infer<typeof MeUser>;

export const MeMembership = z.object({
  tenantSlug: z.string(),
  tenantName: z.string(),
  role: TenantRoleSchema,
});
export type MeMembership = z.infer<typeof MeMembership>;

export const MeResponse = z.object({
  user: MeUser,
  /** Role in the currently-active tenant; null when the caller is a superadmin
   * viewing a tenant they aren't a member of, or has no membership at all. */
  activeTenant: z
    .object({ slug: z.string(), name: z.string(), role: TenantRoleSchema.nullable() })
    .nullable(),
  memberships: z.array(MeMembership),
  /** Resolved capability set for the active tenant — the web gates off this. */
  capabilities: z.array(PermissionSchema),
});
export type MeResponse = z.infer<typeof MeResponse>;

// ─── Tenant-scoped membership management (the Access tab, admin view) ─────────

export const MemberRow = z.object({
  userId: z.string(),
  email: z.string(),
  name: z.string(),
  role: TenantRoleSchema,
  platformRole: PlatformRoleSchema,
  status: z.enum(["active", "suspended"]),
  createdAt: z.number(),
  /** True for the row representing the caller (UI guards self-demotion). */
  isSelf: z.boolean(),
});
export type MemberRow = z.infer<typeof MemberRow>;

export const AddMemberBody = z.object({
  email: z.string().email(),
  role: TenantRoleSchema,
});
export type AddMemberBody = z.infer<typeof AddMemberBody>;

export const UpdateMemberRoleBody = z.object({
  role: TenantRoleSchema,
});
export type UpdateMemberRoleBody = z.infer<typeof UpdateMemberRoleBody>;

// ─── Platform-wide user management (the Access tab, superadmin view) ──────────

export const AdminUserRow = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string(),
  platformRole: PlatformRoleSchema,
  status: z.enum(["active", "suspended"]),
  createdAt: z.number(),
  memberships: z.array(
    z.object({
      tenantSlug: z.string(),
      tenantName: z.string(),
      role: TenantRoleSchema,
    }),
  ),
});
export type AdminUserRow = z.infer<typeof AdminUserRow>;

export const AdminUpdateUserBody = z
  .object({
    platformRole: PlatformRoleSchema.optional(),
    status: z.enum(["active", "suspended"]).optional(),
    /**
     * Admin-set replacement password. Unlike the self-service path
     * (`ChangePasswordBody`) this does not know the user's current password —
     * it is a reset performed on their behalf, so it is superadmin-only and
     * always audited. Treat the value as a temporary credential.
     */
    password: z
      .string()
      .min(PASSWORD_MIN, `password must be ≥ ${PASSWORD_MIN} chars`)
      .optional(),
  })
  .refine(
    (b) =>
      b.platformRole !== undefined ||
      b.status !== undefined ||
      b.password !== undefined,
    { message: "provide platformRole, status and/or password" },
  );
export type AdminUpdateUserBody = z.infer<typeof AdminUpdateUserBody>;

export const AdminCreateUserBody = z.object({
  email: z.string().email(),
  name: z.string().trim().min(1).max(120),
  /**
   * Set by an admin on the user's behalf. The account is usable immediately —
   * there is no invite/activation flow yet — so treat this as a temporary
   * credential and tell the user to change it via POST /v1/me/password.
   */
  password: z.string().min(PASSWORD_MIN, `password must be \u2265 ${PASSWORD_MIN} chars`),
  platformRole: PlatformRoleSchema.default("none"),
  /**
   * Optional initial tenant grant. Without one the new account can sign in but
   * lands on the "request access" empty state, which reads as a broken login.
   */
  membership: z
    .object({ tenantSlug: z.string().min(1).max(64), role: TenantRoleSchema })
    .optional(),
});
export type AdminCreateUserBody = z.infer<typeof AdminCreateUserBody>;

export const AdminMembershipBody = z.object({
  tenantSlug: z.string().min(1).max(64),
  role: TenantRoleSchema,
});
export type AdminMembershipBody = z.infer<typeof AdminMembershipBody>;
