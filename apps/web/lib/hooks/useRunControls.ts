/**
 * useRunControls — pause/resume mutations for the workflow monitor
 * (design §G4). Cancel/replay already live in useRuns.ts; this file adds the
 * NEW `POST /v1/runs/:id/pause` and `POST /v1/runs/:id/resume` endpoints that
 * are being introduced by the runtime work in parallel.
 *
 * A runtime that does not (yet) serve those routes answers 404/405 — callers
 * detect that with `isPauseUnsupportedError` and disable the buttons with a
 * "runtime does not support pause yet" tooltip instead of surfacing an error.
 */
"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ApiResponseError, fetchApiData } from "@/lib/api-response";
import { COUNT_KEYS, RUN_KEYS } from "./useStream";
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

export interface PauseResumeResult {
  runId: string;
  status: string;
  /** pause → paused:true when the park took effect; resume → resumed:true. */
  paused?: boolean;
  resumed?: boolean;
  note?: string;
}

/** True when the API answered 404/405 for pause/resume — i.e. the runtime
 * deployed behind this portal does not serve those endpoints yet. */
export function isPauseUnsupportedError(err: unknown): boolean {
  return (
    err instanceof ApiResponseError &&
    (err.status === 404 || err.status === 405)
  );
}

function invalidate(client: ReturnType<typeof useQueryClient>, id: string) {
  void client.invalidateQueries({ queryKey: RUN_KEYS.detail(id) });
  void client.invalidateQueries({ queryKey: RUN_KEYS.all });
  void client.invalidateQueries({ queryKey: COUNT_KEYS.tenant });
}

/** Pause an in-flight run: `POST /v1/runs/:id/pause`. */
export function usePauseRun() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      callV1<PauseResumeResult>(`/v1/runs/${encodeURIComponent(id)}/pause`, {
        method: "POST",
      }),
    onSettled: (_data, _err, id) => invalidate(client, id),
  });
}

/** Resume a paused run: `POST /v1/runs/:id/resume`. */
export function useResumeRun() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      callV1<PauseResumeResult>(`/v1/runs/${encodeURIComponent(id)}/resume`, {
        method: "POST",
      }),
    onSettled: (_data, _err, id) => invalidate(client, id),
  });
}
