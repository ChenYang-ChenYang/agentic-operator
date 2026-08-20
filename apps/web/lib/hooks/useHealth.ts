/**
 * useHealth — TanStack Query wrapper around `GET /health`.
 *
 * The api exposes an unauthenticated health endpoint (apps/api/src/routes/health.ts)
 * with three sub-component reports: inngest, sqlite, and disk. The Next.js
 * rewrite in `next.config.mjs` routes `/health` to the api on :3540 so this
 * hook works the same in dev and prod.
 *
 * Used by:
 *   - Dashboard SystemHealth panel (FE-P0-4 sub-fix 4b)
 *   - Deployments page LiveCards (Wave 4 follow-up)
 *   - Sidebar footer drilldown (UC-V11-09, deferred)
 *
 * The response shape matches `HealthReport` in `@agentic/contracts`. We poll
 * every 15s so the dashboard reflects sub-component status without manual
 * refresh.
 */
"use client";

import { useQuery } from "@tanstack/react-query";
import type { UseQueryResult } from "@tanstack/react-query";
import { ApiResponseError, fetchApiResponse } from "@/lib/api-response";

export interface HealthReport {
  ok: boolean;
  inngest: {
    ok: boolean;
    reachable?: boolean;
    note?: string;
  };
  sqlite: {
    ok: boolean;
    sizeBytes?: number;
    journalMode?: string;
  };
  disk: {
    ok: boolean;
    logsDir?: string;
    freeBytes?: number;
  };
  schedules?: {
    ok: boolean;
    configured: number;
    disabled: number;
    unconfigured: number;
    configuredAgents: string[];
    disabledAgents: string[];
    unconfiguredAgents: string[];
  };
  llmGateway?: {
    ok: boolean;
    defaultProvider?: string;
    defaultModel?: string;
    providers?: number;
    reachable?: boolean;
    lastCheckedAt?: number;
    latencyMs?: number;
    statusCode?: number | null;
    note?: string;
    mock?: boolean;
    factoryCentralRouting?: boolean;
  };
}

export const HEALTH_KEYS = {
  current: ["health", "current"] as const,
};

/**
 * `/health` is unauthenticated AND does NOT use the {ok, data} envelope —
 * it returns the HealthReport at top level and sets HTTP status 503 when
 * any sub-component is unhealthy. We treat any 2xx OR 503 as a successful
 * fetch (we still want the report on 503).
 */
async function fetchHealth(): Promise<HealthReport> {
  const res = await fetchApiResponse("/health", {
    credentials: "same-origin",
    headers: { Accept: "application/json" },
  });
  // 200 = all-ok, 503 = at least one sub-component failed — both deliver
  // the full report body that we want to surface in the UI.
  const raw = await res.text();
  if (res.status !== 200 && res.status !== 503) {
    let error: Record<string, unknown> | null = null;
    try {
      const decoded = raw ? (JSON.parse(raw) as unknown) : null;
      if (
        decoded &&
        typeof decoded === "object" &&
        !Array.isArray(decoded) &&
        "error" in decoded &&
        decoded.error &&
        typeof decoded.error === "object" &&
        !Array.isArray(decoded.error)
      ) {
        error = decoded.error as Record<string, unknown>;
      }
    } catch {
      // The translated client fallback below retains the raw proxy response.
    }
    const serverMessage =
      error && typeof error.message === "string" ? error.message : null;
    throw new ApiResponseError(
      "/health",
      res.status,
      error && typeof error.code === "string"
        ? error.code
        : `http_${res.status}`,
      serverMessage ?? "",
      {
        clientKind: serverMessage ? undefined : "requestFailed",
        detail: serverMessage
          ? undefined
          : raw.replace(/\s+/g, " ").trim().slice(0, 240) || res.statusText,
        hint: error && typeof error.hint === "string" ? error.hint : undefined,
        serverMessage: serverMessage !== null,
      },
    );
  }
  let body: unknown;
  try {
    body = raw ? JSON.parse(raw) : null;
  } catch {
    throw new ApiResponseError(
      "/health",
      res.status,
      `http_${res.status}`,
      "",
      {
        clientKind: "invalidJson",
        detail: raw.replace(/\s+/g, " ").trim().slice(0, 240),
      },
    );
  }
  if (!isHealthReport(body)) {
    throw new ApiResponseError(
      "/health",
      res.status,
      "invalid_health_report",
      "",
      { clientKind: "invalidHealthReport" },
    );
  }
  return body;
}

function isHealthReport(value: unknown): value is HealthReport {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const report = value as Record<string, unknown>;
  if (typeof report.ok !== "boolean") return false;
  const coreValid = ["inngest", "sqlite", "disk"].every((key) => {
    const subsystem = report[key];
    return (
      subsystem !== null &&
      typeof subsystem === "object" &&
      !Array.isArray(subsystem) &&
      typeof (subsystem as Record<string, unknown>).ok === "boolean"
    );
  });
  if (!coreValid) return false;
  const llmGateway = report.llmGateway;
  return (
    llmGateway === undefined ||
    (llmGateway !== null &&
      typeof llmGateway === "object" &&
      !Array.isArray(llmGateway) &&
      typeof (llmGateway as Record<string, unknown>).ok === "boolean")
  );
}

export function useHealth(): UseQueryResult<HealthReport> {
  return useQuery({
    queryKey: HEALTH_KEYS.current,
    queryFn: fetchHealth,
    staleTime: 15_000,
    // A failed proxy/API request is already visible in the system-health UI.
    // Do not retry it several times and then keep polling every 15 seconds:
    // browsers report every non-2xx fetch in DevTools, which otherwise turns
    // one outage into an endless wall of console errors. Refetching on focus
    // gives the operator a lightweight recovery path after the API returns.
    retry: false,
    refetchInterval: (query) =>
      query.state.status === "error" ? false : 15_000,
    refetchOnWindowFocus: true,
  });
}

/** Format `sqlite.sizeBytes` to a short human string ("8.4 MB"). */
export function fmtBytes(n: number | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}
