/**
 * useTenants — TanStack Query hook for the sidebar tenant switcher.
 *
 * The chrome (`apps/web/app/portal/components/shell/chrome.tsx`) used to
 * read from a static tenant constant, which meant
 * tenants created via `POST /v1/tenants` never showed up until rebuild.
 * This hook makes the sidebar reflect the live DB state.
 *
 * Invalidate via `TENANTS_KEYS.all` after any tenant CRUD mutation:
 *
 *   queryClient.invalidateQueries({ queryKey: TENANTS_KEYS.all });
 */

"use client";

import type {
  TenantDetail,
  TenantInngestDeploymentResponse,
  TenantUpdateBody,
} from "@agentic/contracts";
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from "@tanstack/react-query";
import { fetchApiData } from "@/lib/api-response";
import { tenantHeader } from "./tenant-header";

async function callV1<T>(path: string, init: RequestInit = {}): Promise<T> {
  const { headers: initHeaders, ...rest } = init;
  return fetchApiData<T>(path, {
    credentials: "same-origin",
    ...rest,
    headers: {
      Accept: "application/json",
      ...tenantHeader(),
      ...(initHeaders as Record<string, string> | undefined),
    },
  });
}

export interface TenantListItem {
  id: string;
  slug: string;
  name: string;
  subtitle: string | null;
  color: string | null;
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
  inngestEnabled: boolean;
  inngestProcessScoped: boolean;
  agentCount: number;
  runs24h: number;
  openTasks: number;
  membership: "admin" | "operator" | "viewer" | null;
}

interface TenantsListResponse {
  items: TenantListItem[];
  count: number;
  viewer?: { userId: string | null; isPlatformAdmin: boolean };
}

export const TENANTS_KEYS = {
  all: ["tenants"] as const,
  list: (includeArchived: boolean) => ["tenants", { includeArchived }] as const,
};

export function useTenants(opts?: {
  includeArchived?: boolean;
}): UseQueryResult<TenantsListResponse> {
  const includeArchived = opts?.includeArchived ?? false;
  return useQuery({
    queryKey: TENANTS_KEYS.list(includeArchived),
    queryFn: () =>
      callV1<TenantsListResponse>(
        `/v1/tenants${includeArchived ? "?include_archived=1" : ""}`,
      ),
    // Tenants change rarely; 30s stale time is enough for the sidebar to
    // feel live without hammering the api. Mutations explicitly invalidate.
    staleTime: 30_000,
  });
}

export interface UpdateTenantInput {
  slug: string;
  patch: TenantUpdateBody;
}

/**
 * Update the mutable identity fields of a tenant. Exported separately from
 * the React mutation so the request contract can be unit-tested without a
 * browser/query-client harness.
 */
export function updateTenant(input: UpdateTenantInput): Promise<TenantDetail> {
  return callV1<TenantDetail>(`/v1/tenants/${encodeURIComponent(input.slug)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input.patch),
  });
}

export function useUpdateTenant() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: updateTenant,
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: TENANTS_KEYS.all });
    },
  });
}

export function setTenantInngestDeployment(input: {
  slug: string;
  enabled: boolean;
}): Promise<TenantInngestDeploymentResponse> {
  return callV1<TenantInngestDeploymentResponse>(
    `/v1/tenants/${encodeURIComponent(input.slug)}/inngest-deployment`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: input.enabled }),
    },
  );
}

export function useSetTenantInngestDeployment() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: setTenantInngestDeployment,
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: TENANTS_KEYS.all });
    },
  });
}
