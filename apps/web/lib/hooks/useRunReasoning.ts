"use client";

/**
 * useRunReasoning — the captured LLM turns for one run (GET /v1/reasoning?run=).
 *
 * `llm_turns` stores what the trace artifacts do not: the model's own
 * `reasoning` text and its `responseText`. The monitor timeline joins these
 * onto its turn rows by (stepId, ord) so a rule gate can show the sentences
 * the model actually thought, not just the verdict it landed on.
 *
 * Kept separate from useRunTrace because it is a different table with a
 * different lifetime: a terminal run's turns never change, so they are fetched
 * once and cached.
 */

import { useQuery } from "@tanstack/react-query";
import { fetchApiData } from "@/lib/api-response";
import { tenantHeader } from "./tenant-header";

export interface ReasoningTurnRow {
  id: string;
  runId: string;
  stepId?: string | null;
  ord: number;
  responseText: string | null;
  reasoning: string | null;
  provider: string | null;
  model: string | null;
  finishReason: string | null;
  tokensIn: number | null;
  tokensOut: number | null;
  latencyMs: number | null;
}

export const REASONING_KEYS = {
  run: (runId: string) => ["reasoning", "run", runId] as const,
};

export function useRunReasoning(
  runId: string | null | undefined,
  live = false,
): { turns: ReasoningTurnRow[]; isLoading: boolean } {
  const query = useQuery({
    queryKey: REASONING_KEYS.run(runId ?? ""),
    queryFn: () =>
      fetchApiData<ReasoningTurnRow[]>(
        `/v1/reasoning?limit=200&run=${encodeURIComponent(runId as string)}`,
        {
          credentials: "same-origin",
          headers: { Accept: "application/json", ...tenantHeader() },
        },
      ),
    enabled: Boolean(runId),
    staleTime: live ? 0 : Infinity,
    refetchInterval: live ? 3_000 : false,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: false,
    retry: 1,
  });

  return { turns: query.data ?? [], isLoading: query.isLoading };
}
