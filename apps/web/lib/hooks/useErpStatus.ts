/**
 * useErpStatus — `GET /v1/integrations/erp/status` for the active tenant.
 *
 * Is the Meta ERP behind the LIVE workflow reachable from the API? The
 * workflow page renders `ErpIntegrationBanner` from this while it is not.
 * Polled every 30s (the API caches probes ~20s per URL, so polling never
 * turns into a connection storm); a failed request stops the polling until
 * the operator refocuses the window, like `useHealth`.
 */
"use client";

import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { ErpIntegrationStatus } from "@agentic/contracts";
import { fetchApiData } from "@/lib/api-response";
import { tenantHeader } from "./tenant-header";

export const ERP_STATUS_KEYS = {
  current: ["integrations", "erp", "status"] as const,
};

async function fetchErpStatus(): Promise<ErpIntegrationStatus> {
  const raw = await fetchApiData<unknown>("/v1/integrations/erp/status", {
    credentials: "same-origin",
    headers: { Accept: "application/json", ...tenantHeader() },
  });
  return ErpIntegrationStatus.parse(raw);
}

export function useErpStatus(): UseQueryResult<ErpIntegrationStatus> {
  return useQuery({
    queryKey: ERP_STATUS_KEYS.current,
    queryFn: fetchErpStatus,
    staleTime: 20_000,
    retry: false,
    refetchInterval: (query) =>
      query.state.status === "error" ? false : 30_000,
    refetchOnWindowFocus: true,
  });
}
