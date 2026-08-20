"use client";

import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from "@tanstack/react-query";
import type { AgentFactoryDomain } from "@/lib/domain-display";
import { fetchApiData } from "@/lib/api-response";
import { tenantHeader } from "./tenant-header";

export interface FactoryDomainBinding {
  tenantId: string;
  ontologyDomainId: string;
  ontologyDomainName: string | null;
  source: "explicit" | "auto" | "upload";
  createdAt: string;
  updatedAt: string;
}

export interface AgentFactoryDomainsResponse {
  domains: AgentFactoryDomain[];
  binding: FactoryDomainBinding | null;
  boundDomain: AgentFactoryDomain | null;
  boundActions: Array<{
    id: string;
    name: string;
    description: string | null;
    actor: string[];
  }>;
  gatewayConfigured?: boolean;
  /** Live Allmeta catalog failure; the current bound upload can remain usable. */
  catalogError?: string | null;
}

async function callV1<T>(
  path: string,
  tenant?: string,
  init: RequestInit = {},
): Promise<T> {
  return fetchApiData<T>(path, {
    ...init,
    credentials: "same-origin",
    headers: {
      Accept: "application/json",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...tenantHeader(),
      ...(tenant ? { "x-agentic-tenant": tenant } : {}),
      ...init.headers,
    },
  });
}

export const AGENT_FACTORY_DOMAIN_KEYS = {
  all: ["agent-factory-domains"] as const,
  tenant: (tenant: string) => ["agent-factory-domains", tenant] as const,
};

export function useAgentFactoryDomains(
  tenant: string,
): UseQueryResult<AgentFactoryDomainsResponse> {
  return useQuery({
    // A binding belongs to one runtime tenant. A global cache key could show
    // tenant A's bound ontology while the operator is already viewing B.
    queryKey: AGENT_FACTORY_DOMAIN_KEYS.tenant(tenant),
    queryFn: () =>
      callV1<AgentFactoryDomainsResponse>("/v1/agent-factory/domains", tenant),
    enabled: Boolean(tenant),
    staleTime: 30_000,
  });
}

export interface BindAgentFactoryDomainInput {
  ontologyDomainId: string;
  /** OntoCode's catalog selector binds only authoritative Allmeta identities. */
  source: "allmeta";
  confirmRebind: boolean;
}

interface BindAgentFactoryDomainReceipt {
  binding: FactoryDomainBinding;
  boundDomain: AgentFactoryDomain;
}

export function useBindAgentFactoryDomain(tenant: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: BindAgentFactoryDomainInput) =>
      callV1<BindAgentFactoryDomainReceipt>(
        "/v1/agent-factory/domain-binding",
        tenant,
        {
          method: "PUT",
          body: JSON.stringify(input),
        },
      ),
    onSuccess: () => {
      // The response intentionally omits bound Actions. Re-read the exact
      // tenant-scoped snapshot before the Hub enables Session creation.
      return client.invalidateQueries({
        queryKey: AGENT_FACTORY_DOMAIN_KEYS.tenant(tenant),
        exact: true,
      });
    },
  });
}
