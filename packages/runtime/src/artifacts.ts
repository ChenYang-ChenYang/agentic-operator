/**
 * Shared artifact writer.
 *
 * Both the manifest engine (this package's `step-engine.ts`) and the code
 * engine (`packages/agents/src/run-engine.ts`) write per-step input/output
 * sidecars under `<AGENTIC_ARTIFACTS_DIR>/<runId>/step-N-{input,output}.json`.
 *
 * Previously each engine had its own private copy; the manifest engine had
 * NONE (Audit #3 §10.2, §11.2). Extracting it here closes P0-RT-09 and gives
 * the replay UI a single artifact trail to load.
 */

import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { and, eq } from "drizzle-orm";
import { artifacts, getDb } from "@agentic/db";
import { makeId } from "@agentic/shared";
import {
  AgentRunRecordSchema,
  type AgentRunRecord,
  type ArtifactRole,
} from "@agentic/contracts";

export function artifactsRoot(): string {
  return process.env.AGENTIC_ARTIFACTS_DIR ?? "./artifacts";
}

/**
 * Persist a JSON sidecar for one step's input or output.
 *
 * Returns the absolute path written, suitable for `steps.input_ref` /
 * `steps.output_ref`. Errors propagate to the caller — a failed write is a
 * real problem for replay/debug, not something to silently swallow.
 */
export async function writeArtifact(
  runId: string,
  name: string,
  payload: unknown,
): Promise<string> {
  const body = JSON.stringify(payload, null, 2);
  if (body === undefined) {
    throw new TypeError(`artifact '${name}' is not JSON-serializable`);
  }
  return writeArtifactBody(runId, name, body);
}

async function writeArtifactBody(
  runId: string,
  name: string,
  body: string | Uint8Array,
): Promise<string> {
  assertSafePathPart(runId, "run id");
  assertSafePathPart(name, "artifact logical name");
  const dir = path.resolve(artifactsRoot(), runId);
  await mkdir(dir, { recursive: true });
  const filePath = path.join(dir, name);
  const tempPath = path.join(dir, `.${name}.${randomUUID()}.tmp`);
  const handle = await open(tempPath, "wx");
  try {
    await handle.writeFile(body, "utf8");
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => undefined);
    await unlink(tempPath).catch(() => undefined);
    throw error;
  }
  await handle.close();
  try {
    await rename(tempPath, filePath);
  } catch (error) {
    await unlink(tempPath).catch(() => undefined);
    throw error;
  }
  return filePath;
}

export interface RuntimeArtifactPersistRequest {
  role: ArtifactRole;
  logicalName: string;
  contentType: string;
  payload: unknown;
  stepId?: string;
  schemaId?: string;
  metadata?: Record<string, unknown>;
  redacted?: boolean;
  retentionUntil?: Date;
}

export interface RuntimePersistedArtifact {
  id?: string;
  role: ArtifactRole;
  logicalName: string;
  contentType: string;
  path?: string;
  size: number;
  sha256: string;
  stepId?: string;
  schemaId?: string;
  metadata?: Record<string, unknown>;
  redacted: boolean;
  retentionUntil?: Date;
}

/**
 * Catalog an already-written step sidecar in the durable `artifacts` table.
 * Idempotent for `(tenant, run, step, role, logicalName)` so Inngest retries
 * update evidence instead of producing duplicate cards.
 */
export async function registerStepArtifactEvidence(args: {
  tenantId: string;
  runId: string;
  stepId: string;
  role: "step_input" | "step_output" | "trace";
  filePath: string;
  logicalName?: string;
  contentType?: string;
  metadata?: Record<string, unknown>;
  redacted?: boolean;
  retentionUntil?: Date;
}): Promise<RuntimePersistedArtifact & { id: string; path: string }> {
  const logicalName = args.logicalName ?? path.basename(args.filePath);
  const contentType = args.contentType ?? "application/json";
  const [body, bytes] = await Promise.all([
    readFile(args.filePath),
    stat(args.filePath),
  ]);
  const db = getDb();
  const existing = db
    .select({ id: artifacts.id })
    .from(artifacts)
    .where(
      and(
        eq(artifacts.tenantId, args.tenantId),
        eq(artifacts.runId, args.runId),
        eq(artifacts.stepId, args.stepId),
        eq(artifacts.role, args.role),
        eq(artifacts.logicalName, logicalName),
      ),
    )
    .limit(1)
    .all()[0];
  const id = existing?.id ?? makeId("art");
  const values = {
    kind: contentType,
    role: args.role,
    logicalName,
    contentType,
    sha256: createHash("sha256").update(body).digest("hex"),
    metadataJson: (args.metadata ?? {
      source: "runtime_step_sidecar",
    }) as never,
    redacted: args.redacted ?? false,
    retentionUntil: args.retentionUntil ?? null,
    path: args.filePath,
    size: bytes.size,
  };
  if (existing) {
    db.update(artifacts).set(values).where(eq(artifacts.id, existing.id)).run();
  } else {
    db.insert(artifacts)
      .values({
        id,
        tenantId: args.tenantId,
        runId: args.runId,
        stepId: args.stepId,
        ...values,
      })
      .run();
  }
  return {
    id,
    role: args.role,
    logicalName,
    contentType,
    path: args.filePath,
    size: bytes.size,
    sha256: values.sha256,
    stepId: args.stepId,
    metadata: args.metadata ?? { source: "runtime_step_sidecar" },
    redacted: args.redacted ?? false,
    ...(args.retentionUntil ? { retentionUntil: args.retentionUntil } : {}),
  };
}

/** A sink is bound to an authorized tenant/run by the caller. */
export interface RuntimeArtifactSink {
  persist(
    request: RuntimeArtifactPersistRequest,
  ): Promise<RuntimePersistedArtifact>;
}

export interface PersistTerminalRunArtifactsInput {
  record: AgentRunRecord;
  /** Required (and allowed to be null) when record.status is `ok`. */
  output?: unknown;
  outputFilename?: string;
  rawResponse?: string;
  persistRawResponse?: boolean;
  sink?: RuntimeArtifactSink;
}

export interface PersistedTerminalRunArtifacts {
  output?: RuntimePersistedArtifact;
  rawResponse?: RuntimePersistedArtifact;
  runRecord: RuntimePersistedArtifact;
}

export class ArtifactPersistenceError extends Error {
  readonly code = "artifact_persistence_failed";

  constructor(
    message: string,
    override readonly cause?: unknown,
  ) {
    super(`artifact_persistence_failed: ${message}`);
    this.name = "ArtifactPersistenceError";
  }
}

/**
 * Mandatory terminal artifact lifecycle. Successful runs persist the exact
 * validated output first; every terminal state then persists run-record.json.
 * Callers must not mark a run successful until this function resolves.
 */
export async function persistTerminalRunArtifacts(
  input: PersistTerminalRunArtifactsInput,
): Promise<PersistedTerminalRunArtifacts> {
  let record: AgentRunRecord;
  try {
    record = AgentRunRecordSchema.parse(input.record);
  } catch (error) {
    throw new ArtifactPersistenceError(
      "run record does not match AgentRunRecordSchema",
      error,
    );
  }
  const sink = input.sink ?? createFilesystemArtifactSink(record.runId);
  const result: Partial<PersistedTerminalRunArtifacts> = {};
  try {
    if (record.status === "ok") {
      if (!("output" in input)) {
        throw new TypeError("successful terminal runs require an output value");
      }
      result.output = await sink.persist({
        role: "output",
        logicalName: input.outputFilename ?? "output.json",
        contentType: "application/json",
        payload: input.output,
      });
    }
    if (input.persistRawResponse && input.rawResponse !== undefined) {
      result.rawResponse = await sink.persist({
        role: "raw_response",
        logicalName: "raw-response.txt",
        contentType: "text/plain; charset=utf-8",
        payload: input.rawResponse,
        metadata: { encoding: "utf-8" },
      });
    }
    result.runRecord = await sink.persist({
      role: "run_record",
      logicalName: "run-record.json",
      contentType: "application/json",
      payload: record,
    });
  } catch (error) {
    if (error instanceof ArtifactPersistenceError) throw error;
    throw new ArtifactPersistenceError(
      error instanceof Error ? error.message : String(error),
      error,
    );
  }
  return result as PersistedTerminalRunArtifacts;
}

export function createFilesystemArtifactSink(
  runId: string,
): RuntimeArtifactSink {
  return {
    async persist(request) {
      assertSafePathPart(request.logicalName, "artifact logical name");
      const serialized =
        request.payload instanceof Uint8Array
          ? request.payload
          : request.contentType.startsWith("text/plain") &&
              typeof request.payload === "string"
            ? request.payload
            : JSON.stringify(request.payload, null, 2);
      if (serialized === undefined) {
        throw new TypeError(
          `artifact '${request.logicalName}' is not JSON-serializable`,
        );
      }
      const artifactPath = await writeArtifactBody(
        runId,
        request.logicalName,
        serialized,
      );
      const bytes = await stat(artifactPath);
      return {
        role: request.role,
        logicalName: request.logicalName,
        contentType: request.contentType,
        path: artifactPath,
        size: bytes.size,
        sha256: createHash("sha256").update(serialized).digest("hex"),
        ...(request.stepId ? { stepId: request.stepId } : {}),
        ...(request.schemaId ? { schemaId: request.schemaId } : {}),
        ...(request.metadata ? { metadata: request.metadata } : {}),
        redacted: request.redacted ?? false,
        ...(request.retentionUntil
          ? { retentionUntil: request.retentionUntil }
          : {}),
      };
    },
  };
}

function assertSafePathPart(value: string, label: string): void {
  if (
    value.length === 0 ||
    value === "." ||
    value === ".." ||
    path.basename(value) !== value ||
    value.includes("\0")
  ) {
    throw new TypeError(`${label} must be a safe leaf name`);
  }
}
