import { createHash } from "node:crypto";
import path from "node:path";
import { readFile, stat, unlink } from "node:fs/promises";
import { and, asc, eq, gt, sql } from "drizzle-orm";
import { artifacts, getDb, runTraceEvents, runs } from "@agentic/db";
import { makeId } from "@agentic/shared";
import type {
  ArtifactRole,
  GetRunTraceResponse,
  RunArtifactMetadata,
  RunOutputResponse,
} from "@agentic/contracts";
import {
  createFilesystemArtifactSink,
  type RuntimeArtifactPersistRequest,
  type RuntimeArtifactSink,
  type RuntimePersistedArtifact,
  type RuntimeTraceEventDraft,
  type RuntimeTraceSink,
} from "@agentic/runtime";

type ArtifactRow = typeof artifacts.$inferSelect;

const RESERVED_ARTIFACT_NAMES = new Map<string, ArtifactRole>([
  ["agent-definition.json", "definition"],
  ["run-input.json", "input"],
  ["run-record.json", "run_record"],
  ["raw-response.txt", "raw_response"],
]);
const SINGLETON_ARTIFACT_ROLES = new Set<ArtifactRole>([
  "definition",
  "input",
  "run_record",
  "raw_response",
]);

function boundedLeafName(name: string, maxLength = 240): string {
  if (name.length <= maxLength) return name;
  const rawExtension = path.extname(name);
  const extension =
    rawExtension.length < maxLength
      ? rawExtension
      : rawExtension.slice(0, maxLength - 1);
  const stem = name.slice(0, Math.max(1, maxLength - extension.length));
  return `${stem}${extension}`;
}

function suffixedLeafName(name: string, suffix: number): string {
  const extension = path.extname(name);
  const stem = name.slice(0, name.length - extension.length);
  const marker = `-${suffix}`;
  return `${stem.slice(0, Math.max(1, 240 - extension.length - marker.length))}${marker}${extension}`;
}

function protectedLogicalName(role: ArtifactRole, requested: string): string {
  const bounded = boundedLeafName(requested);
  const reservedFor = RESERVED_ARTIFACT_NAMES.get(bounded.toLowerCase());
  return reservedFor && reservedFor !== role
    ? boundedLeafName(`${role.replaceAll("_", "-")}-${bounded}`)
    : bounded;
}

function artifactIdentity(
  rows: ArtifactRow[],
  request: RuntimeArtifactPersistRequest,
  logicalName: string,
): ArtifactRow | undefined {
  return rows.find((row) => {
    const metadata =
      row.metadataJson && typeof row.metadataJson === "object"
        ? (row.metadataJson as Record<string, unknown>)
        : undefined;
    const normalizedLogicalName = logicalName.toLowerCase();
    const logicalIdentity =
      row.logicalName?.toLowerCase() === normalizedLogicalName ||
      (typeof metadata?.storageRequestedLogicalName === "string" &&
        metadata.storageRequestedLogicalName.toLowerCase() ===
          normalizedLogicalName);
    return (
      row.role === request.role &&
      logicalIdentity &&
      (SINGLETON_ARTIFACT_ROLES.has(request.role) ||
        ((row.stepId ?? null) === (request.stepId ?? null) &&
          (row.schemaId ?? null) === (request.schemaId ?? null)))
    );
  });
}

function toDate(value: Date | undefined): Date | null {
  if (value === undefined) return null;
  return value;
}

function traceStatus(
  status: RuntimeTraceEventDraft["status"],
): "pending" | "running" | "ok" | "failed" | "skipped" {
  return status;
}

export function appendRunTrace(
  tenantId: string,
  draft: RuntimeTraceEventDraft,
): void {
  const db = getDb();
  const ownedRun = db
    .select({ id: runs.id })
    .from(runs)
    .where(and(eq(runs.tenantId, tenantId), eq(runs.id, draft.runId)))
    .limit(1)
    .all()[0];
  if (!ownedRun) throw new Error("run not found for trace append");

  // A Studio execution is sequential, but trace sinks may fan out from a
  // model/tool loop. Retry the tiny max(seq)+insert critical section if two
  // callbacks land in the same turn.
  let lastError: unknown;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      db.transaction(() => {
        const current =
          db
            .select({
              max: sql<number>`coalesce(max(${runTraceEvents.seq}), 0)`,
            })
            .from(runTraceEvents)
            .where(eq(runTraceEvents.runId, draft.runId))
            .all()[0]?.max ?? 0;
        db.insert(runTraceEvents)
          .values({
            id: makeId("trc"),
            tenantId,
            runId: draft.runId,
            stepId: draft.stepId ?? null,
            parentId: draft.parentId ?? null,
            seq: Number(current) + 1,
            kind: draft.kind,
            level: draft.level,
            name: draft.name,
            status: traceStatus(draft.status),
            startedAt: toDate(draft.startedAt),
            endedAt: toDate(draft.endedAt),
            durationMs: draft.durationMs ?? null,
            summary: draft.summary ?? null,
            dataJson: (draft.data ?? null) as never,
            artifactId: draft.artifactId ?? null,
            visibility: draft.visibility,
          })
          .run();
      });
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("failed to append structured trace");
}

export function createDbTraceSink(
  tenantId: string,
  runId: string,
): RuntimeTraceSink {
  return {
    append(event) {
      if (event.runId !== runId) {
        throw new Error("trace sink is bound to a different run");
      }
      appendRunTrace(tenantId, event);
    },
  };
}

export function artifactMetadata(row: ArtifactRow): RunArtifactMetadata {
  return {
    id: row.id,
    runId: row.runId,
    stepId: row.stepId,
    role: row.role,
    logicalName: row.logicalName,
    contentType: row.contentType,
    size: row.size,
    sha256: row.sha256,
    schemaId: row.schemaId,
    metadata:
      row.metadataJson && typeof row.metadataJson === "object"
        ? (row.metadataJson as Record<string, unknown>)
        : null,
    redacted: row.redacted,
    createdAt: row.createdAt,
    retentionUntil: row.retentionUntil,
  };
}

export function createDbArtifactSink(
  tenantId: string,
  runId: string,
  defaultRetentionUntil?: Date,
): RuntimeArtifactSink {
  const filesystem = createFilesystemArtifactSink(runId);
  return {
    async persist(
      request: RuntimeArtifactPersistRequest,
    ): Promise<RuntimePersistedArtifact> {
      const ownedRun = getDb()
        .select({ id: runs.id })
        .from(runs)
        .where(and(eq(runs.tenantId, tenantId), eq(runs.id, runId)))
        .limit(1)
        .all()[0];
      if (!ownedRun) throw new Error("run not found for artifact persistence");

      const existingRows = getDb()
        .select()
        .from(artifacts)
        .where(
          and(eq(artifacts.tenantId, tenantId), eq(artifacts.runId, runId)),
        )
        .all();
      const baseName = protectedLogicalName(request.role, request.logicalName);
      const sameIdentity = artifactIdentity(existingRows, request, baseName);
      let logicalName = sameIdentity?.logicalName ?? baseName;
      if (!sameIdentity) {
        let suffix = 2;
        while (
          existingRows.some(
            (row) =>
              row.logicalName?.toLowerCase() === logicalName.toLowerCase(),
          )
        ) {
          logicalName = suffixedLeafName(baseName, suffix);
          suffix += 1;
        }
      }
      const persistedRequest = {
        ...request,
        logicalName,
        metadata:
          logicalName === request.logicalName
            ? request.metadata
            : {
                ...(request.metadata ?? {}),
                storageRequestedLogicalName: baseName,
              },
        retentionUntil: request.retentionUntil ?? defaultRetentionUntil,
      };
      const written = await filesystem.persist(persistedRequest);
      if (!written.path)
        throw new Error("filesystem artifact sink returned no path");
      // Re-check after the async filesystem write. Cancellation and execution
      // finalizers can converge on run-record.json at the same time; the
      // second continuation must update the row committed by the first rather
      // than create a duplicate catalog entry.
      const committedIdentity =
        sameIdentity ??
        artifactIdentity(
          getDb()
            .select()
            .from(artifacts)
            .where(
              and(eq(artifacts.tenantId, tenantId), eq(artifacts.runId, runId)),
            )
            .all(),
          request,
          written.logicalName,
        );
      const id = committedIdentity?.id ?? makeId("art");
      const values = {
        stepId: written.stepId ?? null,
        kind: written.contentType,
        role: written.role,
        logicalName: written.logicalName,
        contentType: written.contentType,
        sha256: written.sha256,
        schemaId: written.schemaId ?? null,
        metadataJson: (written.metadata ?? null) as never,
        redacted: written.redacted,
        retentionUntil: written.retentionUntil ?? null,
        path: written.path,
        size: written.size,
      };
      try {
        if (committedIdentity) {
          getDb()
            .update(artifacts)
            .set(values)
            .where(
              and(
                eq(artifacts.id, committedIdentity.id),
                eq(artifacts.tenantId, tenantId),
              ),
            )
            .run();
        } else {
          getDb()
            .insert(artifacts)
            .values({ id, tenantId, runId, ...values })
            .run();
        }
      } catch (error) {
        if (!committedIdentity)
          await unlink(written.path).catch(() => undefined);
        throw error;
      }
      return { ...written, id };
    },
  };
}

export function runArtifactRetentionUntil(
  tenantId: string,
  runId: string,
  fallbackFrom = new Date(),
): Date {
  const retained = getDb()
    .select({ retentionUntil: artifacts.retentionUntil })
    .from(artifacts)
    .where(and(eq(artifacts.tenantId, tenantId), eq(artifacts.runId, runId)))
    .all()
    .find((row) => row.retentionUntil !== null)?.retentionUntil;
  return (
    retained ?? new Date(fallbackFrom.getTime() + 3_650 * 24 * 60 * 60 * 1_000)
  );
}

export async function registerExistingRunArtifact(args: {
  tenantId: string;
  runId: string;
  stepId: string;
  role: "step_input" | "step_output";
  filePath: string;
  retentionUntil?: Date;
}): Promise<RunArtifactMetadata> {
  const existing = getDb()
    .select()
    .from(artifacts)
    .where(
      and(
        eq(artifacts.tenantId, args.tenantId),
        eq(artifacts.runId, args.runId),
        eq(artifacts.stepId, args.stepId),
        eq(artifacts.role, args.role),
      ),
    )
    .limit(1)
    .all()[0];
  if (existing) return artifactMetadata(existing);
  const body = await readFile(args.filePath);
  const bytes = await stat(args.filePath);
  const id = makeId("art");
  getDb()
    .insert(artifacts)
    .values({
      id,
      tenantId: args.tenantId,
      runId: args.runId,
      stepId: args.stepId,
      kind: "application/json",
      role: args.role,
      logicalName: path.basename(args.filePath),
      contentType: "application/json",
      sha256: createHash("sha256").update(body).digest("hex"),
      metadataJson: { source: "runtime_step_sidecar" },
      redacted: false,
      retentionUntil: args.retentionUntil ?? null,
      path: args.filePath,
      size: bytes.size,
    })
    .run();
  return artifactMetadata(
    getDb().select().from(artifacts).where(eq(artifacts.id, id)).all()[0]!,
  );
}

export function listRunArtifacts(
  tenantId: string,
  runId: string,
): RunArtifactMetadata[] {
  return getDb()
    .select({ artifact: artifacts })
    .from(artifacts)
    .innerJoin(runs, eq(runs.id, artifacts.runId))
    .where(and(eq(runs.tenantId, tenantId), eq(artifacts.runId, runId)))
    .orderBy(asc(artifacts.createdAt))
    .all()
    .map((row) => artifactMetadata(row.artifact));
}

export function getRunTrace(
  tenantId: string,
  runId: string,
  after: number,
  limit: number,
): GetRunTraceResponse | null {
  const ownedRun = getDb()
    .select({ id: runs.id })
    .from(runs)
    .where(and(eq(runs.tenantId, tenantId), eq(runs.id, runId)))
    .limit(1)
    .all()[0];
  if (!ownedRun) return null;
  const rows = getDb()
    .select()
    .from(runTraceEvents)
    .where(
      and(
        eq(runTraceEvents.tenantId, tenantId),
        eq(runTraceEvents.runId, runId),
        gt(runTraceEvents.seq, after),
      ),
    )
    .orderBy(asc(runTraceEvents.seq))
    .limit(limit)
    .all();
  return {
    events: rows.map((row) => ({
      id: row.id,
      runId: row.runId,
      stepId: row.stepId,
      parentId: row.parentId,
      seq: row.seq,
      kind: row.kind,
      level: row.level,
      name: row.name,
      status: row.status,
      startedAt: row.startedAt,
      endedAt: row.endedAt,
      durationMs: row.durationMs,
      summary: row.summary,
      data:
        row.dataJson && typeof row.dataJson === "object"
          ? (row.dataJson as Record<string, unknown>)
          : null,
      artifactId: row.artifactId,
      visibility: row.visibility,
      createdAt: row.createdAt,
    })),
    nextAfter: rows.length === limit ? (rows.at(-1)?.seq ?? null) : null,
  };
}

export async function getRunOutput(
  tenantId: string,
  runId: string,
): Promise<RunOutputResponse | null> {
  const run = getDb()
    .select({
      id: runs.id,
      status: runs.status,
      outputValid: runs.outputValid,
    })
    .from(runs)
    .where(and(eq(runs.tenantId, tenantId), eq(runs.id, runId)))
    .limit(1)
    .all()[0];
  if (!run) return null;
  const outputArtifacts = getDb()
    .select()
    .from(artifacts)
    .where(
      and(
        eq(artifacts.tenantId, tenantId),
        eq(artifacts.runId, runId),
        eq(artifacts.role, "output"),
      ),
    )
    .orderBy(asc(artifacts.createdAt))
    .all();
  const artifact =
    outputArtifacts.find(
      (candidate) => candidate.schemaId === "agent-output:aggregate",
    ) ?? outputArtifacts[0];
  let output: unknown = null;
  if (
    artifact &&
    run.status === "ok" &&
    (!artifact.retentionUntil || artifact.retentionUntil.getTime() > Date.now())
  ) {
    const raw = await readFile(artifact.path, "utf8");
    output = JSON.parse(raw) as unknown;
  }
  return {
    runId: run.id,
    status: run.status,
    output,
    outputValid: run.outputValid,
    artifact: artifact ? artifactMetadata(artifact) : null,
  };
}
