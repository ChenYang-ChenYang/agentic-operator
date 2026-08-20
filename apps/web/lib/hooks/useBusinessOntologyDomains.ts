"use client";

import {
  useMutation,
  useQuery,
  useQueries,
  useQueryClient,
  type UseQueryResult,
} from "@tanstack/react-query";
import type {
  ArchiveBusinessOntologyDomainRequest,
  BusinessOntologyDomain,
  BusinessOntologyDomainCatalogItem,
  BusinessOntologyDomainOntologyReceipt,
  CreateBusinessOntologyDomainRequest,
  UpdateBusinessOntologyDomainRequest,
} from "@agentic/contracts";
import { fetchApiData } from "@/lib/api-response";
import { tenantHeader } from "./tenant-header";

export interface BusinessOntologyDomainListReceipt {
  items: BusinessOntologyDomain[];
  count: number;
}

export interface BusinessOntologyDomainCatalogReceipt {
  items: BusinessOntologyDomainCatalogItem[];
  count: number;
  catalogError: string | null;
}

export interface BusinessOntologyDomainMutationReceipt {
  domain: BusinessOntologyDomain;
  mode:
    | "created"
    | "attached"
    | "updated"
    | "verified"
    | "runtime_bound"
    | "archived";
}

export interface BusinessOntologyDomainListOptions {
  includeArchived?: boolean;
  includeUnavailable?: boolean;
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

export const BUSINESS_ONTOLOGY_DOMAIN_KEYS = {
  all: ["business-ontology-domains"] as const,
  tenant: (tenant: string) => ["business-ontology-domains", tenant] as const,
  list: (
    tenant: string,
    options: Required<BusinessOntologyDomainListOptions>,
  ) =>
    [
      "business-ontology-domains",
      tenant,
      "list",
      options.includeArchived,
      options.includeUnavailable,
    ] as const,
  catalog: (tenant: string) =>
    ["business-ontology-domains", tenant, "catalog"] as const,
  ontology: (tenant: string, registrationId: string) =>
    ["business-ontology-domains", tenant, "ontology", registrationId] as const,
};

export function useBusinessOntologyDomains(
  tenant: string,
  options: BusinessOntologyDomainListOptions = {},
): UseQueryResult<BusinessOntologyDomainListReceipt> {
  const resolved = {
    includeArchived: options.includeArchived ?? false,
    includeUnavailable: options.includeUnavailable ?? true,
  };
  const search = new URLSearchParams({
    includeArchived: String(resolved.includeArchived),
    includeUnavailable: String(resolved.includeUnavailable),
  });
  return useQuery({
    queryKey: BUSINESS_ONTOLOGY_DOMAIN_KEYS.list(tenant, resolved),
    queryFn: () =>
      callV1<BusinessOntologyDomainListReceipt>(
        tenant,
        `/v1/business-ontology-domains?${search.toString()}`,
      ),
    enabled: Boolean(tenant),
    staleTime: 5_000,
  });
}

export function useBusinessOntologyDomainCatalog(
  tenant: string,
): UseQueryResult<BusinessOntologyDomainCatalogReceipt> {
  return useQuery({
    queryKey: BUSINESS_ONTOLOGY_DOMAIN_KEYS.catalog(tenant),
    queryFn: () =>
      callV1<BusinessOntologyDomainCatalogReceipt>(
        tenant,
        "/v1/business-ontology-domains/catalog",
      ),
    enabled: Boolean(tenant),
    staleTime: 15_000,
  });
}

export interface BusinessOntologyDomainOntologyQuery {
  registrationId: string;
  query: UseQueryResult<BusinessOntologyDomainOntologyReceipt>;
}

/**
 * Read active registrations through their exact authoritative sources. A
 * `useQueries` collection stays valid as the tenant-owned registry changes,
 * while each result is cached by Business Domain plus stable registration id.
 */
export function useBusinessOntologyDomainOntologies(
  tenant: string,
  registrationIds: string[],
): BusinessOntologyDomainOntologyQuery[] {
  const uniqueIds = [...new Set(registrationIds.filter(Boolean))];
  const queries = useQueries({
    queries: uniqueIds.map((registrationId) => ({
      queryKey: BUSINESS_ONTOLOGY_DOMAIN_KEYS.ontology(tenant, registrationId),
      queryFn: () =>
        callV1<BusinessOntologyDomainOntologyReceipt>(
          tenant,
          `/v1/business-ontology-domains/${encodeURIComponent(
            registrationId,
          )}/ontology`,
        ),
      enabled: Boolean(tenant && registrationId),
      staleTime: 5_000,
    })),
  }) as UseQueryResult<BusinessOntologyDomainOntologyReceipt>[];

  return uniqueIds.map((registrationId, index) => ({
    registrationId,
    query: queries[index]!,
  }));
}

function useInvalidateBusinessOntologyDomains(tenant: string) {
  const client = useQueryClient();
  return () =>
    Promise.all([
      client.invalidateQueries({
        queryKey: BUSINESS_ONTOLOGY_DOMAIN_KEYS.tenant(tenant),
      }),
      client.invalidateQueries({
        queryKey: BUSINESS_ONTOLOGY_DOMAIN_KEYS.catalog(tenant),
      }),
    ]);
}

export function useRegisterBusinessOntologyDomain(tenant: string) {
  const invalidate = useInvalidateBusinessOntologyDomains(tenant);
  return useMutation({
    mutationFn: (input: CreateBusinessOntologyDomainRequest) =>
      callV1<BusinessOntologyDomainMutationReceipt>(
        tenant,
        "/v1/business-ontology-domains",
        {
          method: "POST",
          body: JSON.stringify(input),
        },
      ),
    onSuccess: invalidate,
  });
}

export function useUpdateBusinessOntologyDomain(tenant: string) {
  const invalidate = useInvalidateBusinessOntologyDomains(tenant);
  return useMutation({
    mutationFn: (input: {
      registrationId: string;
      patch: UpdateBusinessOntologyDomainRequest;
    }) =>
      callV1<BusinessOntologyDomainMutationReceipt>(
        tenant,
        `/v1/business-ontology-domains/${encodeURIComponent(
          input.registrationId,
        )}`,
        {
          method: "PATCH",
          body: JSON.stringify(input.patch),
        },
      ),
    onSuccess: invalidate,
  });
}

export function useVerifyBusinessOntologyDomain(tenant: string) {
  const invalidate = useInvalidateBusinessOntologyDomains(tenant);
  return useMutation({
    mutationFn: (registrationId: string) =>
      callV1<BusinessOntologyDomainMutationReceipt>(
        tenant,
        `/v1/business-ontology-domains/${encodeURIComponent(
          registrationId,
        )}/verify`,
        {
          method: "POST",
          body: JSON.stringify({}),
        },
      ),
    onSuccess: invalidate,
  });
}

export function useArchiveBusinessOntologyDomain(tenant: string) {
  const invalidate = useInvalidateBusinessOntologyDomains(tenant);
  return useMutation({
    mutationFn: (input: {
      registrationId: string;
      request: ArchiveBusinessOntologyDomainRequest;
    }) =>
      callV1<BusinessOntologyDomainMutationReceipt>(
        tenant,
        `/v1/business-ontology-domains/${encodeURIComponent(
          input.registrationId,
        )}`,
        {
          method: "DELETE",
          body: JSON.stringify(input.request),
        },
      ),
    onSuccess: invalidate,
  });
}
