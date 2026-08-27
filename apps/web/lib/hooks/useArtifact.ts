"use client";

/**
 * useArtifact — one artifact blob by id (GET /v1/artifacts/:id).
 *
 * Used by the monitor timeline to read a tool call's evidence receipt when its
 * row is expanded. Fetching is deliberately lazy and per-row: a single run can
 * carry a hundred tool calls, and pulling every receipt up front would cost
 * more requests than the rest of the page combined against an api that allows
 * 600 reads/min per user.
 *
 * Artifacts are immutable once written, so a fetched blob never goes stale and
 * is cached for the session.
 */

import { useQuery } from "@tanstack/react-query";
import { fetchApiData } from "@/lib/api-response";
import { tenantHeader } from "./tenant-header";

export const ARTIFACT_KEYS = {
  detail: (id: string) => ["artifacts", "detail", id] as const,
};

export function useArtifact(artifactId: string | null | undefined): {
  data: unknown;
  isLoading: boolean;
  isError: boolean;
} {
  const query = useQuery({
    queryKey: ARTIFACT_KEYS.detail(artifactId ?? ""),
    queryFn: () =>
      fetchApiData<unknown>(
        `/v1/artifacts/${encodeURIComponent(artifactId as string)}`,
        {
          credentials: "same-origin",
          headers: { Accept: "application/json", ...tenantHeader() },
        },
      ),
    enabled: Boolean(artifactId),
    // Immutable by construction — never refetch.
    staleTime: Infinity,
    gcTime: 10 * 60_000,
    refetchOnWindowFocus: false,
    retry: 1,
  });

  return {
    data: query.data,
    isLoading: query.isLoading,
    isError: query.isError,
  };
}
