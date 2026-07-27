"use client";

import { useEffect, useRef } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import {
  OntoCodeSessionEventSchema,
  type OntoCodeSessionEvent,
} from "@agentic/contracts";
import { ONTOCODE_KEYS } from "./useOntoCodeWorkspace";

export type OntoCodeStreamState =
  | "connecting"
  | "connected"
  | "reconnecting"
  | "closed";

export interface UseOntoCodeSessionStreamOptions {
  enabled?: boolean;
  onEvent?: (event: OntoCodeSessionEvent) => void;
  onStatusChange?: (status: OntoCodeStreamState) => void;
}

const MAX_BACKOFF_MS = 30_000;

export interface OntoCodeSseFrame {
  id: string;
  event: string;
  data: string;
}

export function ontocodeStreamPath(
  sessionId: string,
  lastEventId = "",
): string {
  const path = `/v1/ontocode/sessions/${encodeURIComponent(sessionId)}/stream`;
  if (!lastEventId) return path;
  return `${path}?lastEventId=${encodeURIComponent(lastEventId)}`;
}

export function parseOntoCodeSseFrame(frame: string): OntoCodeSseFrame | null {
  let id = "";
  let event = "message";
  const data: string[] = [];
  for (const rawLine of frame.split(/\r?\n/)) {
    if (!rawLine || rawLine.startsWith(":")) continue;
    const separator = rawLine.indexOf(":");
    const field = separator === -1 ? rawLine : rawLine.slice(0, separator);
    const rawValue = separator === -1 ? "" : rawLine.slice(separator + 1);
    const value = rawValue.startsWith(" ") ? rawValue.slice(1) : rawValue;
    if (field === "id") id = value;
    if (field === "event") event = value;
    if (field === "data") data.push(value);
  }
  if (!data.length) return null;
  return { id, event, data: data.join("\n") };
}

export function invalidateOntoCodeEvent(
  client: QueryClient,
  tenant: string,
  sessionId: string,
): void {
  void client.invalidateQueries({
    queryKey: ONTOCODE_KEYS.session(tenant, sessionId),
  });
  void client.invalidateQueries({
    queryKey: ONTOCODE_KEYS.sessions(tenant),
  });
  void client.invalidateQueries({
    queryKey: ONTOCODE_KEYS.messages(tenant, sessionId),
  });
  void client.invalidateQueries({
    queryKey: ONTOCODE_KEYS.commands(tenant, sessionId),
  });
  void client.invalidateQueries({
    queryKey: ONTOCODE_KEYS.jobs(tenant, sessionId),
  });
  void client.invalidateQueries({
    queryKey: ONTOCODE_KEYS.assistantRuns(tenant, sessionId),
  });
  void client.invalidateQueries({
    queryKey: ONTOCODE_KEYS.candidateHead(tenant, sessionId),
  });
  void client.invalidateQueries({
    queryKey: ["ontocode", tenant, "session", sessionId, "changesets"],
  });
  void client.invalidateQueries({
    queryKey: ["ontocode", tenant, "session", sessionId, "artifacts"],
  });
  void client.invalidateQueries({
    queryKey: ["ontocode", tenant, "session", sessionId, "evidence"],
  });
  void client.invalidateQueries({
    queryKey: ["ontocode", tenant, "session", sessionId, "events"],
  });
  void client.invalidateQueries({
    queryKey: ["ontocode", tenant, "session", sessionId, "configuration-tasks"],
  });
}

/**
 * Live transport for committed OntoCode session events.
 *
 * The durable event sequence is carried across explicit reconnects. A fetch
 * stream is used instead of EventSource so the tenant selector can travel in
 * the same authenticated request as every other portal query. Query data
 * remains authoritative; SSE only invalidates projections after commit.
 */
export function useOntoCodeSessionStream(
  tenant: string,
  sessionId: string,
  options: UseOntoCodeSessionStreamOptions = {},
): void {
  const client = useQueryClient();
  const enabled = options.enabled ?? true;
  const onEventRef = useRef(options.onEvent);
  const onStatusRef = useRef(options.onStatusChange);

  useEffect(() => {
    onEventRef.current = options.onEvent;
    onStatusRef.current = options.onStatusChange;
  }, [options.onEvent, options.onStatusChange]);

  useEffect(() => {
    if (!enabled || !tenant || !sessionId) {
      onStatusRef.current?.("closed");
      return;
    }

    let controller: AbortController | null = null;
    let cancelled = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;
    let lastEventId = "";

    const scheduleReconnect = () => {
      if (cancelled) return;
      attempt += 1;
      onStatusRef.current?.("reconnecting");
      const delay = Math.min(MAX_BACKOFF_MS, 500 * 2 ** Math.min(attempt, 6));
      reconnectTimer = setTimeout(() => void connect(), delay);
    };

    const connect = async () => {
      if (cancelled) return;
      onStatusRef.current?.(attempt ? "reconnecting" : "connecting");
      controller = new AbortController();
      try {
        const response = await fetch(
          ontocodeStreamPath(sessionId, lastEventId),
          {
            credentials: "same-origin",
            cache: "no-store",
            headers: {
              Accept: "text/event-stream",
              "x-agentic-tenant": tenant,
              ...(lastEventId ? { "Last-Event-ID": lastEventId } : {}),
            },
            signal: controller.signal,
          },
        );
        if (!response.ok || !response.body) {
          throw new Error(
            `OntoCode event stream failed with HTTP ${response.status}`,
          );
        }
        attempt = 0;
        onStatusRef.current?.("connected");
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        while (!cancelled) {
          const result = await reader.read();
          buffer += decoder.decode(result.value, { stream: !result.done });
          let boundary = buffer.search(/\r?\n\r?\n/);
          while (boundary >= 0) {
            const rawFrame = buffer.slice(0, boundary);
            const delimiter = buffer.slice(boundary).match(/^\r?\n\r?\n/)?.[0];
            buffer = buffer.slice(boundary + (delimiter?.length ?? 2));
            const frame = parseOntoCodeSseFrame(rawFrame);
            if (frame?.event === "stream.error") {
              throw new Error("OntoCode event stream reported a poll failure");
            }
            if (frame?.event === "message") {
              let payload: unknown;
              try {
                payload = JSON.parse(frame.data) as unknown;
              } catch (error) {
                console.warn("[ontocode.stream] dropped non-JSON event", error);
                boundary = buffer.search(/\r?\n\r?\n/);
                continue;
              }
              const parsed = OntoCodeSessionEventSchema.safeParse(payload);
              if (!parsed.success || parsed.data.sessionId !== sessionId) {
                console.warn(
                  "[ontocode.stream] dropped malformed or foreign event",
                  parsed.success ? parsed.data : parsed.error,
                );
              } else {
                if (frame.id) lastEventId = frame.id;
                invalidateOntoCodeEvent(client, tenant, sessionId);
                onEventRef.current?.(parsed.data);
              }
            }
            boundary = buffer.search(/\r?\n\r?\n/);
          }
          if (result.done) break;
        }
        reader.releaseLock();
        if (!cancelled) scheduleReconnect();
      } catch (error) {
        if (cancelled || controller.signal.aborted) return;
        console.warn(
          "[ontocode.stream] reconnecting after transport error",
          error,
        );
        scheduleReconnect();
      }
    };

    void connect();
    return () => {
      cancelled = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      controller?.abort();
      onStatusRef.current?.("closed");
    };
  }, [client, enabled, sessionId, tenant]);
}
