/**
 * useAccess — TanStack Query hooks for the Access tab.
 *
 *   useMembers / useAddMember / useUpdateMemberRole / useRemoveMember
 *       → tenant-scoped membership management (GET/POST/PATCH/DELETE /v1/members)
 *   useAdminUsers / useUpdateUser / useGrantMembership / useRevokeMembership
 *       → platform-wide user administration (/v1/admin/users*)
 *
 * All write hooks invalidate the relevant list so the table stays live.
 */

"use client";

import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from "@tanstack/react-query";
import type { AdminUserRow, MemberRow, TenantRole } from "@agentic/contracts";
import { fetchApiData } from "@/lib/api-response";
import { tenantHeader } from "./tenant-header";

async function callV1<T>(path: string, init: RequestInit = {}): Promise<T> {
  const { headers: initHeaders, ...rest } = init;
  // Only set a JSON content-type when there's a body — Fastify 400s on an empty
  // body with `content-type: application/json`, which would break bodyless
  // DELETE (remove member, revoke membership, delete user).
  return fetchApiData<T>(path, {
    credentials: "same-origin",
    ...rest,
    headers: {
      Accept: "application/json",
      ...(init.body != null ? { "content-type": "application/json" } : {}),
      ...tenantHeader(),
      ...(initHeaders as Record<string, string> | undefined),
    },
  });
}

export const ACCESS_KEYS = {
  members: ["access", "members"] as const,
  users: ["access", "admin-users"] as const,
};

// ─── Tenant-scoped members ───────────────────────────────────────────────────

export function useMembers(enabled: boolean): UseQueryResult<MemberRow[]> {
  return useQuery({
    queryKey: ACCESS_KEYS.members,
    queryFn: () =>
      callV1<{ items: MemberRow[] }>("/v1/members").then((d) => d.items),
    enabled,
    staleTime: 10_000,
    retry: false,
  });
}

export function useAddMember() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { email: string; role: TenantRole }) =>
      callV1<{ items: MemberRow[] }>("/v1/members", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ACCESS_KEYS.members }),
  });
}

export function useUpdateMemberRole() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ userId, role }: { userId: string; role: TenantRole }) =>
      callV1<{ items: MemberRow[] }>(`/v1/members/${userId}`, {
        method: "PATCH",
        body: JSON.stringify({ role }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ACCESS_KEYS.members }),
  });
}

export function useRemoveMember() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (userId: string) =>
      callV1<{ items: MemberRow[] }>(`/v1/members/${userId}`, {
        method: "DELETE",
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ACCESS_KEYS.members }),
  });
}

// ─── Platform-wide users (superadmin) ────────────────────────────────────────

export function useAdminUsers(
  enabled: boolean,
): UseQueryResult<AdminUserRow[]> {
  return useQuery({
    queryKey: ACCESS_KEYS.users,
    queryFn: () =>
      callV1<{ items: AdminUserRow[] }>("/v1/admin/users").then((d) => d.items),
    enabled,
    staleTime: 10_000,
    retry: false,
  });
}

/**
 * Admin-provisioned account. Unlike `/v1/auth/register` (self-service, always
 * platformRole "none" and no grant), this sets the role and the initial tenant
 * membership in one commit so the new user is not stranded on "request access".
 */
export function useCreateUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      email: string;
      name: string;
      password: string;
      platformRole?: "none" | "superadmin";
      membership?: { tenantSlug: string; role: TenantRole };
    }) =>
      callV1<{ items: AdminUserRow[] }>("/v1/admin/users", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ACCESS_KEYS.users });
      // A grant in the active tenant also changes the Members tab.
      qc.invalidateQueries({ queryKey: ACCESS_KEYS.members });
    },
  });
}

export function useUpdateUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      userId,
      ...body
    }: {
      userId: string;
      platformRole?: "none" | "superadmin";
      status?: "active" | "suspended";
      /** Admin-set replacement password; superadmin-only and audited server-side. */
      password?: string;
    }) =>
      callV1<{ items: AdminUserRow[] }>(`/v1/admin/users/${userId}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ACCESS_KEYS.users }),
  });
}

export function useGrantMembership() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      userId,
      tenantSlug,
      role,
    }: {
      userId: string;
      tenantSlug: string;
      role: TenantRole;
    }) =>
      callV1<{ items: AdminUserRow[] }>(
        `/v1/admin/users/${userId}/memberships`,
        {
          method: "POST",
          body: JSON.stringify({ tenantSlug, role }),
        },
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ACCESS_KEYS.users }),
  });
}

export function useDeleteUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (userId: string) =>
      callV1<{ items: AdminUserRow[] }>(`/v1/admin/users/${userId}`, {
        method: "DELETE",
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ACCESS_KEYS.users }),
  });
}

export function useRevokeMembership() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      userId,
      tenantSlug,
    }: {
      userId: string;
      tenantSlug: string;
    }) =>
      callV1<{ items: AdminUserRow[] }>(
        `/v1/admin/users/${userId}/memberships/${tenantSlug}`,
        { method: "DELETE" },
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ACCESS_KEYS.users }),
  });
}
