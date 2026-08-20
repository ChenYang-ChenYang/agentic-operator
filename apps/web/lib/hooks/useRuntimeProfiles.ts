"use client";

import type {
  BindBusinessOntologyDomainRuntimeProfileRequest,
  CreateRuntimeProfileRequest,
  CreateRuntimeProfileVersionRequest,
  RuntimeProfile,
  RuntimeProfileVersion,
} from "@agentic/contracts";
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from "@tanstack/react-query";
import { fetchApiData } from "@/lib/api-response";
import { BUSINESS_ONTOLOGY_DOMAIN_KEYS } from "./useBusinessOntologyDomains";
import { tenantHeader } from "./tenant-header";

export interface RuntimeProfileWithVersions {
  profile: RuntimeProfile;
  versions: RuntimeProfileVersion[];
}

export interface RuntimeProfileListReceipt {
  items: RuntimeProfileWithVersions[];
  count: number;
}

export interface RuntimeProfileMutationReceipt {
  profile: RuntimeProfile;
  version: RuntimeProfileVersion | null;
  mode: "created" | "version_created" | "archived";
}

export interface RuntimeProfileBindingReceipt {
  domain: import("@agentic/contracts").BusinessOntologyDomain;
  mode: "runtime_bound";
}

async function callV1<T>(
  tenant: string,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const { headers, ...rest } = init;
  return fetchApiData<T>(path, {
    credentials: "same-origin",
    ...rest,
    headers: {
      Accept: "application/json",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...tenantHeader(),
      "x-agentic-tenant": tenant,
      ...(headers as Record<string, string> | undefined),
    },
  });
}

export const RUNTIME_PROFILE_KEYS = {
  all: ["runtime-profiles"] as const,
  tenant: (tenant: string) => ["runtime-profiles", tenant] as const,
  list: (tenant: string, includeArchived: boolean) =>
    ["runtime-profiles", tenant, "list", includeArchived] as const,
};

export function useRuntimeProfiles(
  tenant: string,
  options: { includeArchived?: boolean } = {},
): UseQueryResult<RuntimeProfileListReceipt> {
  const includeArchived = options.includeArchived ?? false;
  return useQuery({
    queryKey: RUNTIME_PROFILE_KEYS.list(tenant, includeArchived),
    queryFn: () =>
      callV1<RuntimeProfileListReceipt>(
        tenant,
        `/v1/runtime-profiles?includeArchived=${String(includeArchived)}`,
      ),
    enabled: Boolean(tenant),
    staleTime: 5_000,
  });
}

function useInvalidateRuntimeProfiles(tenant: string) {
  const client = useQueryClient();
  return () =>
    Promise.all([
      client.invalidateQueries({
        queryKey: RUNTIME_PROFILE_KEYS.tenant(tenant),
      }),
      client.invalidateQueries({
        queryKey: BUSINESS_ONTOLOGY_DOMAIN_KEYS.tenant(tenant),
      }),
    ]);
}

export function useCreateRuntimeProfile(tenant: string) {
  const invalidate = useInvalidateRuntimeProfiles(tenant);
  return useMutation({
    mutationFn: (input: CreateRuntimeProfileRequest) =>
      callV1<RuntimeProfileMutationReceipt>(tenant, "/v1/runtime-profiles", {
        method: "POST",
        body: JSON.stringify(input),
      }),
    onSuccess: invalidate,
  });
}

export function useCreateRuntimeProfileVersion(tenant: string) {
  const invalidate = useInvalidateRuntimeProfiles(tenant);
  return useMutation({
    mutationFn: (input: {
      profileId: string;
      request: CreateRuntimeProfileVersionRequest;
    }) =>
      callV1<RuntimeProfileMutationReceipt>(
        tenant,
        `/v1/runtime-profiles/${encodeURIComponent(
          input.profileId,
        )}/versions`,
        {
          method: "POST",
          body: JSON.stringify(input.request),
        },
      ),
    onSuccess: invalidate,
  });
}

export function useArchiveRuntimeProfile(tenant: string) {
  const invalidate = useInvalidateRuntimeProfiles(tenant);
  return useMutation({
    mutationFn: (input: {
      profileId: string;
      request: { confirmName: string };
    }) =>
      callV1<RuntimeProfileMutationReceipt>(
        tenant,
        `/v1/runtime-profiles/${encodeURIComponent(input.profileId)}`,
        {
          method: "DELETE",
          body: JSON.stringify(input.request),
        },
      ),
    onSuccess: invalidate,
  });
}

export function useBindBusinessOntologyDomainRuntimeProfile(tenant: string) {
  const invalidate = useInvalidateRuntimeProfiles(tenant);
  return useMutation({
    mutationFn: (input: {
      registrationId: string;
      request: BindBusinessOntologyDomainRuntimeProfileRequest;
    }) =>
      callV1<RuntimeProfileBindingReceipt>(
        tenant,
        `/v1/business-ontology-domains/${encodeURIComponent(
          input.registrationId,
        )}/runtime-profile`,
        {
          method: "PUT",
          body: JSON.stringify(input.request),
        },
      ),
    onSuccess: invalidate,
  });
}
