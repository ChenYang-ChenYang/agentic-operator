/**
 * Per-run log writer — appends structured lines to
 * `logs/<tenant>/runs/<YYYY-MM-DD>/<run-id>.log`.
 *
 * Line format (DESIGN.md §8):
 *   2026-05-16T08:14:02.001Z  INFO   run.start  run_id=run-01000 ...
 *
 * Writes are append-only with O_APPEND so concurrent writers from different
 * steps interleave safely.
 */

import { constants } from "node:fs";
import { mkdir, open, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { publish } from "./broadcast";

const LEVELS = ["DEBUG", "INFO", "WARN", "ERROR"] as const;
export type LogLevel = (typeof LEVELS)[number];

function logRoot() {
  return process.env.AGENTIC_LOGS_DIR ?? "./logs";
}

function dateDir(at: Date = new Date()): string {
  const y = at.getUTCFullYear();
  const m = String(at.getUTCMonth() + 1).padStart(2, "0");
  const d = String(at.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export interface RunLogContext {
  tenantSlug: string;
  /** Internal tenant id. When present, every persisted line is mirrored to
   * the tenant-scoped SSE channel as `log.line`. */
  tenantId?: string;
  runId: string;
  correlationId: string;
  agentName?: string;
  /** Frozen path persisted on runs.log_path; prevents a run crossing UTC
   * midnight from splitting across two daily files. */
  logPath?: string;
}

export function logPathFor(ctx: RunLogContext, at: Date = new Date()): string {
  return path.resolve(
    logRoot(),
    ctx.tenantSlug,
    "runs",
    dateDir(at),
    `${ctx.runId}.log`,
  );
}

/** Resolve a persisted log path and prove it remains inside this tenant's
 * configured runs directory. Database paths are data, not filesystem
 * authority; rejecting traversal/poisoned rows prevents a run id from being
 * turned into an arbitrary-file read or append. */
export function authorizedRunLogPath(
  tenantSlug: string,
  candidate: string,
): string {
  const root = path.resolve(logRoot(), tenantSlug, "runs");
  const resolved = path.resolve(candidate);
  const relative = path.relative(root, resolved);
  if (
    !relative ||
    relative.startsWith(`..${path.sep}`) ||
    relative === ".." ||
    path.isAbsolute(relative)
  ) {
    throw new Error(
      `run log path is outside the configured tenant log root: ${candidate}`,
    );
  }
  return resolved;
}

const SENSITIVE_FIELD =
  /(?:authorization|cookie|password|passwd|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|private[_-]?key)/i;
const MAX_FIELD_STRING = 32 * 1024;

function sanitizeValue(
  value: unknown,
  key: string,
  seen: WeakSet<object>,
  depth = 0,
): unknown {
  if (SENSITIVE_FIELD.test(key)) return "[REDACTED]";
  if (typeof value === "string") {
    return value.length > MAX_FIELD_STRING
      ? `${value.slice(0, MAX_FIELD_STRING)}…[truncated ${value.length - MAX_FIELD_STRING} chars]`
      : value;
  }
  if (!value || typeof value !== "object" || depth >= 8) return value;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  if (Array.isArray(value))
    return value.map((item) => sanitizeValue(item, key, seen, depth + 1));
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(
      ([childKey, child]) => [
        childKey,
        sanitizeValue(child, childKey, seen, depth + 1),
      ],
    ),
  );
}

function sanitizeFields(
  fields: Record<string, unknown>,
): Record<string, unknown> {
  const seen = new WeakSet<object>();
  return Object.fromEntries(
    Object.entries(fields).map(([key, value]) => [
      key,
      sanitizeValue(value, key, seen),
    ]),
  );
}

function fmtFields(fields: Record<string, unknown>): string {
  return Object.entries(fields)
    .map(([k, v]) => {
      let encoded: string | undefined;
      if (typeof v === "string" && /^[A-Za-z0-9_.:/@+-]+$/.test(v)) {
        encoded = v;
      } else {
        try {
          encoded = JSON.stringify(v);
        } catch {
          encoded = JSON.stringify(String(v));
        }
      }
      return `${k}=${encoded ?? "null"}`;
    })
    .join(" ");
}

export async function writeRunLog(
  ctx: RunLogContext,
  level: LogLevel,
  event: string,
  fields: Record<string, unknown> = {},
): Promise<void> {
  const ts = new Date().toISOString();
  const allFields = sanitizeFields({
    run_id: ctx.runId,
    correlation_id: ctx.correlationId,
    ...fields,
  });
  const eventToken = event.replace(/[^A-Za-z0-9_.:-]+/g, "_") || "log";
  const line = `${ts}  ${level.padEnd(6)} ${eventToken.padEnd(10)} ${fmtFields(allFields)}\n`;
  const filePath = authorizedRunLogPath(
    ctx.tenantSlug,
    ctx.logPath ?? logPathFor(ctx),
  );
  const directory = path.dirname(filePath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const [realRoot, realDirectory] = await Promise.all([
    realpath(path.resolve(logRoot(), ctx.tenantSlug, "runs")),
    realpath(directory),
  ]);
  const realRelative = path.relative(realRoot, realDirectory);
  if (
    realRelative.startsWith(`..${path.sep}`) ||
    realRelative === ".." ||
    path.isAbsolute(realRelative)
  ) {
    throw new Error(
      `run log directory resolves outside tenant root: ${directory}`,
    );
  }
  let existed = true;
  try {
    await stat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") existed = false;
    else throw error;
  }
  // O_APPEND keeps concurrent writers from overwriting each other; fsync is
  // part of the success contract because these files are the authoritative
  // terminal evidence after a process crash.
  const handle = await open(
    filePath,
    constants.O_APPEND |
      constants.O_CREAT |
      constants.O_WRONLY |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(line, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  if (!existed) {
    // File fsync makes bytes durable; syncing the containing directory makes
    // the newly-created directory entry durable across a crash as well.
    const directoryHandle = await open(directory, "r");
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  }

  // The terminal must reflect what was actually persisted, not a parallel
  // synthetic message. Mirror only after appendFile succeeds. A missing
  // tenant id is allowed for standalone runtime harnesses; those still get
  // the file log but cannot be safely routed to an SSE tenant channel.
  if (ctx.tenantId) {
    try {
      publish({
        type: "log.line",
        tenantId: ctx.tenantId,
        at: new Date(ts).getTime(),
        runId: ctx.runId,
        correlationId: ctx.correlationId,
        level,
        event,
        message: line.trimEnd(),
        fields: allFields,
      });

      // Tool calls are first-class supervision records in addition to being
      // terminal lines. Derive the stable event at the single log-writing
      // boundary so every runtime tier reports the same contract.
      if (event === "tool.call" && typeof fields.tool === "string") {
        const rawDuration = fields.duration_ms ?? fields.duration;
        const durationMs =
          typeof rawDuration === "number"
            ? rawDuration
            : typeof rawDuration === "string"
              ? Number.parseFloat(rawDuration)
              : null;
        publish({
          type: "tool.call.completed",
          tenantId: ctx.tenantId,
          at: new Date(ts).getTime(),
          runId: ctx.runId,
          correlationId: ctx.correlationId,
          agentName: ctx.agentName ?? null,
          stepName: typeof fields.step === "string" ? fields.step : null,
          toolName: fields.tool,
          durationMs: Number.isFinite(durationMs) ? durationMs : null,
          ok: fields.ok !== false && level !== "ERROR",
          error: typeof fields.error === "string" ? fields.error : null,
          url: typeof fields.url === "string" ? fields.url : null,
          request: typeof fields.request === "string" ? fields.request : null,
        });
      }
    } catch (error) {
      // Live delivery is best-effort and must never turn a successful file
      // append into a failed agent step.
      console.warn(
        "[log-writer] persisted line but live delivery failed",
        error,
      );
    }
  }
}
