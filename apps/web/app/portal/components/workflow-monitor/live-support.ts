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

/**
 * Human duration for step/turn rows: 838 → "838ms", 12_400 → "12.4s",
 * 1_831_853 → "30m 32s".
 *
 * The live panel previously printed the raw millisecond count, so a half-hour
 * step read as "1831853MS" — a number nobody parses at a glance, least of all
 * from across a room.
 */
export function fmtDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) {
    return "—";
  }
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const totalSeconds = ms / 1000;
  if (totalSeconds < 60) {
    return `${totalSeconds.toFixed(totalSeconds < 10 ? 1 : 0)}s`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.round(totalSeconds - minutes * 60);
  if (minutes < 60) return `${minutes}m ${seconds}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes - hours * 60}m`;
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
