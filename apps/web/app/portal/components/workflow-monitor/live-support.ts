/**
 * Pure display helpers shared by the workflow-monitor components (§G4).
 */
import type { AgentLiveStatus } from "@/lib/hooks/useWorkflowLiveState";

/** CSS token for a live agent state. */
export function liveStatusColor(status: AgentLiveStatus): string {
  switch (status) {
    case "running":
      return "var(--signal)";
    case "ok":
      return "var(--green)";
    case "failed":
      return "var(--red)";
    case "waiting_human":
      return "var(--amber)";
    default:
      return "var(--text-3)";
  }
}

export function liveStatusLabel(status: AgentLiveStatus): string {
  switch (status) {
    case "waiting_human":
      return "waiting for human";
    default:
      return status;
  }
}

/** CSS token for a persisted run status (runs.status column values). */
export function runStatusColor(status: string): string {
  switch (status) {
    case "running":
    case "queued":
      return "var(--signal)";
    case "ok":
      return "var(--green)";
    case "failed":
      return "var(--red)";
    case "cancelled":
      return "var(--text-3)";
    case "waiting":
    case "paused":
      return "var(--amber)";
    default:
      return "var(--text-3)";
  }
}

/** A run the API would still accept a cancel for. */
export function isRunActive(status: string): boolean {
  return !["ok", "failed", "cancelled"].includes(status);
}

/** Compact token count: 1234 → "1.2k". */
export function fmtTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** Compact relative time for chip subtitles. */
export function fmtAgoShort(iso: string | null): string {
  if (!iso) return "—";
  const at = new Date(iso).getTime();
  if (!Number.isFinite(at)) return "—";
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86_400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86_400)}d`;
}
