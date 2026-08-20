import { readFile } from "node:fs/promises";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import {
  agentDraftRevisions,
  agentRunSessions,
  agents,
  agentVersions,
  artifacts,
  events,
  eventTypes,
  getDb,
  runMessages,
  runs,
  steps,
  workflows,
  workflowVersions,
} from "@agentic/db";
import { makeId } from "@agentic/shared";
import {
  AgentDefinitionV2Schema,
  STUDIO_AGENT_RUN_CONTROL_EVENT,
  STUDIO_CHAT_MESSAGE_EVENT,
  StudioAgentRunEventDataSchema,
  StudioLogicalTriggerPayloadSchema,
  type AgentDefinitionV2,
  type AgentInputPortV2,
  type AgentRunRecord,
  type AgentRunSession,
  type CreateAgentRunBody,
  type CreateAgentRunResponse,
  type ReplayStudioRunBody,
  type StudioAgentRunEventData,
  type StudioLogicalTriggerPayload,
  normalizeAgentDefinition,
} from "@agentic/contracts";
import {
  AgentInputValidationError,
  ArtifactPersistenceError,
  appendToLedger,
  bindTriggerInputs,
  canonicalJson,
  createFilteredTraceSink,
  finalizeAgentExecution,
  inngest,
  normalizeAgentForExecution,
  persistTerminalRunArtifacts,
  prepareAgentExecution,
  runAction,
  logPathFor,
  writeRunLog,
  type AgentConversationTurn,
  type RuntimeTraceSink,
} from "@agentic/runtime";
import type { TenantRegistry } from "@agentic/agent-kit";
import { getGlobalToolCatalogEntry } from "@agentic/tools";
import type { InngestFunction } from "inngest";
import { currentUsageAttribution } from "@agentic/llm-gateway";
import type { AuthedContext } from "../plugins/auth";
import {
  AgentStudioNotFoundError,
  checkpointDraft,
  definitionHash,
  findStudioAgent,
  getDraft,
  getDraftRevision,
  getLiveAgentSnapshot,
} from "./agent-drafts";
import {
  createDbArtifactSink,
  createDbTraceSink,
  listRunArtifacts,
  registerExistingRunArtifact,
  runArtifactRetentionUntil,
} from "./studio-observability";

interface PinnedDefinition {
  definition: AgentDefinitionV2;
  definitionHash: string;
  agentVersionId: string | null;
  draftRevisionId: string | null;
}

function retentionUntil(
  definition: AgentDefinitionV2,
  from = new Date(),
): Date {
  const days = definition.observability?.retention_days ?? 3_650;
  return new Date(from.getTime() + days * 24 * 60 * 60 * 1_000);
}

function createStudioTraceSink(
  tenantId: string,
  runId: string,
  definition: AgentDefinitionV2,
): RuntimeTraceSink {
  return createFilteredTraceSink(createDbTraceSink(tenantId, runId), {
    traceLevel: definition.observability?.trace_level,
    reasoningSummary: definition.observability?.reasoning_summary,
  });
}

export class StudioRunInputError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly issues?: unknown,
  ) {
    super(message);
    this.name = "StudioRunInputError";
  }
}

function resolveStudioTriggerEvent(
  definition: AgentDefinitionV2,
  requested: string | undefined,
): string {
  if (requested !== undefined && !definition.trigger.includes(requested)) {
    throw new StudioRunInputError(
      "trigger_event_invalid",
      `Agent '${definition.name}' does not listen for '${requested}'.`,
      { requested, available: definition.trigger },
    );
  }
  return requested ?? definition.trigger[0] ?? STUDIO_CHAT_MESSAGE_EVENT;
}

function studioPromptPort(
  definition: AgentDefinitionV2,
): AgentInputPortV2 | null {
  const promptPorts = definition.inputs.filter(
    (input) => input.kind === "prompt",
  );
  if (promptPorts.length > 1) {
    throw new StudioRunInputError(
      "prompt_input_count_invalid",
      "Test Lab chat supports at most one prompt input on the agent definition.",
      { count: promptPorts.length },
    );
  }
  return promptPorts[0] ?? null;
}

const STUDIO_LOGICAL_TRIGGER_RESERVED_FIELDS = new Set([
  "event_type",
  "event_name",
  "event_id",
  "request_id",
  "run_id",
  "session_id",
  "correlation_id",
  "prompt",
  "input",
  "context",
  "subject",
  // Never let the public logical payload recursively contain either the
  // private Studio control envelope or its authored-input collection.
  "inputs",
  "payload",
  "schemaVersion",
  "eventId",
  "eventName",
  "runId",
  "sessionId",
  "correlationId",
  "agentId",
  "definitionHash",
  "tenantId",
  "tenantSlug",
  "conversationHistory",
  "runtimeOverrides",
  "toolPolicy",
]);

function studioPayloadFields(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(
      ([key]) =>
        !key.startsWith("__") &&
        !STUDIO_LOGICAL_TRIGGER_RESERVED_FIELDS.has(key),
    ),
  );
}

function studioAuthoredPayload(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Construct the single logical trigger payload used by the ledger, the
 * generated-agent event context and the legacy `payload` input port. Runtime
 * trigger/run identity and exact chat text win over caller-supplied aliases;
 * authored request/context and other non-reserved payload fields survive.
 */
export function buildStudioLogicalTriggerPayload(args: {
  eventName: string;
  eventId: string;
  runId: string;
  sessionId: string;
  correlationId: string;
  prompt: string;
  subject: string | null;
  authoredPayload: unknown;
}): StudioLogicalTriggerPayload {
  const authoredPayload = studioAuthoredPayload(args.authoredPayload);
  const authoredRequestId = authoredPayload.request_id;
  const requestId =
    typeof authoredRequestId === "string" && authoredRequestId.trim()
      ? authoredRequestId
      : args.correlationId;
  const context =
    authoredPayload.context === undefined
      ? args.prompt
      : authoredPayload.context;
  return StudioLogicalTriggerPayloadSchema.parse({
    ...studioPayloadFields(authoredPayload),
    event_type: args.eventName,
    event_name: args.eventName,
    event_id: args.eventId,
    request_id: requestId,
    run_id: args.runId,
    session_id: args.sessionId,
    correlation_id: args.correlationId,
    prompt: args.prompt,
    input: args.prompt,
    context,
    ...(args.subject === null ? {} : { subject: args.subject }),
  });
}

export const STUDIO_CONVERSATION_HISTORY_METADATA_KEY =
  "__agentic_conversation_history";
const MAX_CONVERSATION_HISTORY_MESSAGES = 20;
const MAX_CONVERSATION_HISTORY_BYTES = 64 * 1024;

function conversationHistoryBytes(history: AgentConversationTurn[]): number {
  return Buffer.byteLength(JSON.stringify(history), "utf8");
}

function truncateConversationTurn(
  turn: AgentConversationTurn,
): AgentConversationTurn {
  const codePoints = Array.from(turn.content);
  let low = 0;
  let high = codePoints.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const candidate = [
      { ...turn, content: codePoints.slice(0, middle).join("") },
    ];
    if (conversationHistoryBytes(candidate) <= MAX_CONVERSATION_HISTORY_BYTES) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return { ...turn, content: codePoints.slice(0, low).join("") };
}

function boundConversationHistory(
  history: AgentConversationTurn[],
): AgentConversationTurn[] {
  const bounded = history
    .slice(-MAX_CONVERSATION_HISTORY_MESSAGES)
    .map((turn) => ({ role: turn.role, content: turn.content }));
  while (
    bounded.length > 1 &&
    conversationHistoryBytes(bounded) > MAX_CONVERSATION_HISTORY_BYTES
  ) {
    bounded.shift();
  }
  if (
    bounded.length === 1 &&
    conversationHistoryBytes(bounded) > MAX_CONVERSATION_HISTORY_BYTES
  ) {
    bounded[0] = truncateConversationTurn(bounded[0]!);
  }
  return bounded;
}

function normalizeUserPrompt(content: unknown): string | null {
  const prompt =
    typeof content === "string"
      ? content
      : content && typeof content === "object" && !Array.isArray(content)
        ? (content as Record<string, unknown>).prompt
        : undefined;
  if (typeof prompt !== "string") return null;
  return prompt.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
}

function normalizeAssistantTurn(content: unknown): string {
  // Compatibility-mode agents often persist their model response as a plain
  // string. JSON-encoding that string again adds quote/backslash wrappers to
  // the next model turn, so preserve it verbatim; structured outputs still
  // use deterministic JSON.
  return typeof content === "string" ? content : canonicalJson(content);
}

function loadSessionConversationHistory(
  tenantId: string,
  sessionId: string,
): AgentConversationTurn[] {
  const rows = getDb()
    .select({ role: runMessages.role, content: runMessages.contentJson })
    .from(runMessages)
    .where(
      and(
        eq(runMessages.tenantId, tenantId),
        eq(runMessages.sessionId, sessionId),
        inArray(runMessages.role, ["user", "assistant"]),
      ),
    )
    .orderBy(desc(runMessages.ord))
    .limit(MAX_CONVERSATION_HISTORY_MESSAGES)
    .all()
    .reverse();
  const history: AgentConversationTurn[] = [];
  for (const row of rows) {
    if (row.role === "user") {
      const content = normalizeUserPrompt(row.content);
      if (content !== null) history.push({ role: "user", content });
    } else if (row.role === "assistant") {
      history.push({
        role: "assistant",
        content: normalizeAssistantTurn(row.content),
      });
    }
  }
  return boundConversationHistory(history);
}

function validateConversationHistory(
  value: unknown,
  code: string,
  message: string,
): AgentConversationTurn[] {
  if (!Array.isArray(value)) {
    throw new StudioRunInputError(code, message);
  }
  const history: AgentConversationTurn[] = [];
  for (const turn of value) {
    const candidate = turn as Record<string, unknown>;
    if (
      !turn ||
      typeof turn !== "object" ||
      Array.isArray(turn) ||
      (candidate.role !== "user" && candidate.role !== "assistant") ||
      typeof candidate.content !== "string"
    ) {
      throw new StudioRunInputError(code, message);
    }
    history.push({
      role: candidate.role,
      content: candidate.content,
    });
  }
  if (
    history.length > MAX_CONVERSATION_HISTORY_MESSAGES ||
    conversationHistoryBytes(history) > MAX_CONVERSATION_HISTORY_BYTES
  ) {
    throw new StudioRunInputError(
      code,
      `${message} It exceeds the supported limits.`,
    );
  }
  return history;
}

function parseConversationHistorySnapshot(
  value: unknown,
): AgentConversationTurn[] {
  return validateConversationHistory(
    value,
    "replay_context_invalid",
    "The original run conversation snapshot is invalid.",
  );
}

function parseEventConversationHistory(
  value: unknown,
): AgentConversationTurn[] {
  if (value === undefined) return [];
  return validateConversationHistory(
    value,
    "conversation_context_invalid",
    "The dispatched conversation snapshot is invalid.",
  );
}

interface StudioFileUpload {
  original: Record<string, unknown>;
  port: AgentInputPortV2;
  index: number;
  name: string;
  contentType: string;
  bytes: Buffer;
}

function mediaTypeAllowed(contentType: string, allowed: string[]): boolean {
  const normalized = contentType.toLowerCase();
  return allowed.some((value) => {
    const candidate = value.toLowerCase();
    return candidate.endsWith("/*")
      ? normalized.startsWith(candidate.slice(0, -1))
      : candidate === normalized;
  });
}

const STRICT_BASE64 =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const MEDIA_TYPE = /^[a-z0-9!#$%&'*+.^_`{|}~-]+\/[a-z0-9!#$%&'*+.^_`{|}~-]+$/;

function collectStudioFileUploads(
  definition: AgentDefinitionV2,
  inputs: Record<string, unknown>,
): StudioFileUpload[] {
  const uploads: StudioFileUpload[] = [];
  for (const port of definition.inputs.filter(
    (input) => input.kind === "file",
  )) {
    const raw = inputs[port.id];
    if (raw === undefined || typeof raw === "string") continue;
    const values = Array.isArray(raw) ? raw : [raw];
    if (Array.isArray(raw) && port.file?.multiple !== true) {
      throw new StudioRunInputError(
        "file_multiple_forbidden",
        `Input '${port.id}' accepts only one file.`,
      );
    }
    for (const [index, value] of values.entries()) {
      if (typeof value === "string") continue;
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new StudioRunInputError(
          "file_input_invalid",
          `Input '${port.id}' must be an uploaded file or artifact id.`,
        );
      }
      const record = value as Record<string, unknown>;
      if (typeof record.artifactId === "string") continue;
      if (typeof record.dataUrl !== "string") {
        throw new StudioRunInputError(
          "file_content_missing",
          `Uploaded file for '${port.id}' has no dataUrl content.`,
        );
      }
      const match = record.dataUrl.match(
        /^data:([^;,]+);base64,([A-Za-z0-9+/=\r\n]*)$/,
      );
      if (!match) {
        throw new StudioRunInputError(
          "file_data_url_invalid",
          `Uploaded file for '${port.id}' is not a valid base64 data URL.`,
        );
      }
      const encoded = match[2]!.replaceAll(/\s/g, "");
      if (!STRICT_BASE64.test(encoded)) {
        throw new StudioRunInputError(
          "file_data_url_invalid",
          `Uploaded file for '${port.id}' contains invalid base64 data.`,
        );
      }
      const contentType = match[1]!.trim().toLowerCase();
      if (!MEDIA_TYPE.test(contentType)) {
        throw new StudioRunInputError(
          "file_media_type_invalid",
          `Uploaded file for '${port.id}' has an invalid media type.`,
        );
      }
      const claimedType = record.type ?? record.contentType;
      if (
        claimedType !== undefined &&
        String(claimedType).trim().toLowerCase() !== contentType
      ) {
        throw new StudioRunInputError(
          "file_media_type_mismatch",
          `Uploaded file for '${port.id}' declares a media type that does not match its data URL.`,
        );
      }
      const bytes = Buffer.from(encoded, "base64");
      const maxBytes = port.file?.max_bytes ?? 10_000_000;
      if (bytes.byteLength > maxBytes) {
        throw new StudioRunInputError(
          "file_too_large",
          `File '${String(record.name ?? "upload")}' exceeds the ${maxBytes}-byte limit for '${port.id}'.`,
        );
      }
      const allowed = port.file?.media_types ?? [];
      if (allowed.length > 0 && !mediaTypeAllowed(contentType, allowed)) {
        throw new StudioRunInputError(
          "file_media_type_forbidden",
          `Media type '${contentType}' is not allowed for '${port.id}'.`,
          { allowed },
        );
      }
      const unsafeName = String(record.name ?? `${port.id}-${index + 1}`);
      const name =
        unsafeName.replaceAll(/[^A-Za-z0-9._-]/g, "_").slice(0, 160) ||
        "upload.bin";
      uploads.push({
        original: record,
        port,
        index,
        name,
        contentType,
        bytes,
      });
    }
  }
  return uploads;
}

async function normalizeStudioFileReferences(
  tenantId: string,
  definition: AgentDefinitionV2,
  inputs: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const referencedIds = new Set<string>();
  for (const port of definition.inputs.filter(
    (input) => input.kind === "file",
  )) {
    const raw = inputs[port.id];
    for (const value of Array.isArray(raw) ? raw : [raw]) {
      if (typeof value === "string" && value.length > 0) {
        referencedIds.add(value);
      } else if (
        value &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        typeof (value as Record<string, unknown>).artifactId === "string"
      ) {
        referencedIds.add(
          (value as Record<string, unknown>).artifactId as string,
        );
      }
    }
  }
  if (referencedIds.size === 0) return { ...inputs };

  const rows = getDb()
    .select()
    .from(artifacts)
    .where(
      and(
        eq(artifacts.tenantId, tenantId),
        inArray(artifacts.id, [...referencedIds]),
      ),
    )
    .all();
  const byId = new Map(rows.map((row) => [row.id, row]));
  const now = Date.now();

  const normalizeReference = (value: unknown): unknown => {
    const artifactId =
      typeof value === "string"
        ? value
        : value && typeof value === "object" && !Array.isArray(value)
          ? (value as Record<string, unknown>).artifactId
          : undefined;
    if (typeof artifactId !== "string") return value;
    const row = byId.get(artifactId);
    if (!row) {
      throw new StudioRunInputError(
        "file_artifact_not_found",
        "A referenced file artifact does not exist for this tenant.",
      );
    }
    if (row.retentionUntil && row.retentionUntil.getTime() <= now) {
      throw new StudioRunInputError(
        "file_artifact_expired",
        `Referenced file artifact '${artifactId}' has expired.`,
      );
    }
    if (typeof value === "string") return value;

    const original = value as Record<string, unknown>;
    const safe: Record<string, unknown> = { artifactId: row.id };
    if (Object.hasOwn(original, "id")) safe.id = row.id;
    if (Object.hasOwn(original, "name") && row.logicalName) {
      safe.name = row.logicalName;
    }
    if (Object.hasOwn(original, "logicalName") && row.logicalName) {
      safe.logicalName = row.logicalName;
    }
    if (Object.hasOwn(original, "contentType") && row.contentType) {
      safe.contentType = row.contentType;
    }
    if (Object.hasOwn(original, "mediaType") && row.contentType) {
      safe.mediaType = row.contentType;
    }
    if (Object.hasOwn(original, "size")) safe.size = row.size;
    if (Object.hasOwn(original, "sha256") && row.sha256) {
      safe.sha256 = row.sha256;
    }
    return safe;
  };

  const normalized = { ...inputs };
  for (const port of definition.inputs.filter(
    (input) => input.kind === "file",
  )) {
    const raw = normalized[port.id];
    normalized[port.id] = Array.isArray(raw)
      ? raw.map(normalizeReference)
      : normalizeReference(raw);
  }
  return normalized;
}

function stripInlineFileData(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripInlineFileData);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => key !== "dataUrl")
      .map(([key, nested]) => [key, stripInlineFileData(nested)]),
  );
}

function loadPublishedDefinition(
  ctx: Pick<AuthedContext, "tenantId">,
  agentId: string,
  versionId?: string,
): PinnedDefinition {
  if (!versionId) {
    const live = getLiveAgentSnapshot(ctx, agentId);
    if (!live) throw new AgentStudioNotFoundError("version");
    return {
      definition: live.definition,
      definitionHash: live.definitionHash,
      agentVersionId: live.agentVersionId,
      draftRevisionId: null,
    };
  }
  const row = getDb()
    .select({
      definition: agentVersions.manifestJson,
      contentHash: agentVersions.contentHash,
    })
    .from(agentVersions)
    .innerJoin(
      workflowVersions,
      eq(workflowVersions.id, agentVersions.workflowVersionId),
    )
    .innerJoin(workflows, eq(workflows.id, workflowVersions.workflowId))
    .where(
      and(
        eq(workflows.tenantId, ctx.tenantId),
        eq(agentVersions.agentId, agentId),
        eq(agentVersions.id, versionId),
      ),
    )
    .limit(1)
    .all()[0];
  if (!row) throw new AgentStudioNotFoundError("version");
  const definition = normalizeAgentDefinition(row.definition);
  return {
    definition,
    definitionHash: row.contentHash ?? definitionHash(definition),
    agentVersionId: versionId,
    draftRevisionId: null,
  };
}

function resolvePinnedDefinition(
  ctx: AuthedContext,
  agentId: string,
  body: CreateAgentRunBody,
): PinnedDefinition {
  if (body.target.kind === "live") {
    return loadPublishedDefinition(ctx, agentId, body.target.agentVersionId);
  }
  const draft = getDraft(ctx, body.target.draftId);
  if (draft.agentId !== agentId) throw new AgentStudioNotFoundError("draft");
  const revision = body.target.revision
    ? getDraftRevision(ctx, body.target.draftId, body.target.revision)
    : checkpointDraft(ctx, body.target.draftId, "run");
  return {
    definition: revision.definition,
    definitionHash: revision.definitionHash,
    agentVersionId: null,
    draftRevisionId: revision.id,
  };
}

function resolveSessionContinuationTrigger(
  tenantId: string,
  agentId: string,
  sessionId: string | undefined,
  pinned: PinnedDefinition,
  requestedTrigger: string | undefined,
  fallbackTrigger: string,
): string {
  if (!sessionId) return fallbackTrigger;
  const latest = getDb()
    .select({
      agentVersionId: runs.agentVersionId,
      draftRevisionId: runs.draftRevisionId,
      eventName: events.name,
    })
    .from(runs)
    .leftJoin(events, eq(events.id, runs.triggerEventId))
    .where(
      and(
        eq(runs.tenantId, tenantId),
        eq(runs.agentId, agentId),
        eq(runs.sessionId, sessionId),
      ),
    )
    .orderBy(desc(runs.queuedAt), desc(runs.id))
    .limit(1)
    .all()[0];
  if (!latest) return fallbackTrigger;

  if (
    latest.agentVersionId !== pinned.agentVersionId ||
    latest.draftRevisionId !== pinned.draftRevisionId
  ) {
    throw new StudioRunInputError(
      "session_target_mismatch",
      "A saved conversation must continue on the same pinned agent version. Start a new chat to change the target.",
      { sessionId },
    );
  }
  if (
    latest.eventName &&
    requestedTrigger !== undefined &&
    latest.eventName !== requestedTrigger
  ) {
    throw new StudioRunInputError(
      "session_trigger_mismatch",
      `This conversation is pinned to trigger '${latest.eventName}'. Start a new chat to use '${requestedTrigger}'.`,
      { sessionId, expected: latest.eventName, received: requestedTrigger },
    );
  }
  return latest.eventName
    ? resolveStudioTriggerEvent(pinned.definition, latest.eventName)
    : fallbackTrigger;
}

function createSession(
  ctx: AuthedContext,
  agentId: string,
  requestedId: string | undefined,
  title: string,
  preparedId?: string,
): AgentRunSession {
  const db = getDb();
  if (requestedId) {
    const row = db
      .select()
      .from(agentRunSessions)
      .where(
        and(
          eq(agentRunSessions.tenantId, ctx.tenantId),
          eq(agentRunSessions.agentId, agentId),
          eq(agentRunSessions.id, requestedId),
        ),
      )
      .limit(1)
      .all()[0];
    if (!row) {
      throw new StudioRunInputError(
        "session_not_found",
        "The requested run session does not exist for this agent.",
      );
    }
    return row;
  }
  const id = preparedId ?? makeId("ars");
  const now = new Date();
  db.insert(agentRunSessions)
    .values({
      id,
      tenantId: ctx.tenantId,
      agentId,
      createdBy: null,
      title: title.slice(0, 240),
      createdAt: now,
      updatedAt: now,
      lastRunAt: null,
    })
    .run();
  return db
    .select()
    .from(agentRunSessions)
    .where(eq(agentRunSessions.id, id))
    .all()[0]!;
}

function appendSessionMessage(
  tenantId: string,
  sessionId: string,
  runId: string,
  role: "user" | "assistant",
  content: unknown,
): void {
  const db = getDb();
  let lastError: unknown;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const current =
        db
          .select({ max: sql<number>`coalesce(max(${runMessages.ord}), 0)` })
          .from(runMessages)
          .where(eq(runMessages.sessionId, sessionId))
          .all()[0]?.max ?? 0;
      db.insert(runMessages)
        .values({
          id: makeId("msg"),
          tenantId,
          sessionId,
          runId,
          ord: Number(current) + 1,
          role,
          contentJson: content as never,
        })
        .run();
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("failed to append run session message");
}

function tryAppendSessionMessage(
  tenantId: string,
  sessionId: string,
  runId: string,
  role: "user" | "assistant",
  content: unknown,
): boolean {
  try {
    appendSessionMessage(tenantId, sessionId, runId, role, content);
    return true;
  } catch {
    return false;
  }
}

function appendTerminalSessionMessageOnce(
  tenantId: string,
  sessionId: string,
  runId: string,
  content: unknown,
): void {
  const existing = getDb()
    .select({ id: runMessages.id })
    .from(runMessages)
    .where(
      and(
        eq(runMessages.tenantId, tenantId),
        eq(runMessages.runId, runId),
        eq(runMessages.role, "assistant"),
      ),
    )
    .limit(1)
    .all()[0];
  if (!existing) {
    tryAppendSessionMessage(tenantId, sessionId, runId, "assistant", content);
  }
}

export async function reserveStudioRun(
  ctx: AuthedContext,
  agentRef: string,
  body: CreateAgentRunBody,
  options: {
    source?: "studio" | "replay";
    conversationHistorySnapshot?: AgentConversationTurn[];
  } = {},
): Promise<CreateAgentRunResponse> {
  const agent = findStudioAgent(ctx, agentRef);
  if (!agent) throw new AgentStudioNotFoundError("agent");
  if (agent.kind !== "manifest") {
    throw new StudioRunInputError(
      "agent_runtime_unsupported",
      "Code-defined agents must run through their registered code runtime; Agent Studio cannot infer that behavior from metadata.",
    );
  }
  if (agent.lifecycle === "archived") {
    throw new StudioRunInputError(
      "agent_archived",
      "Archived agents cannot be executed.",
    );
  }
  const pinned = resolvePinnedDefinition(ctx, agent.id, body);
  const requestedTriggerEvent = resolveStudioTriggerEvent(
    pinned.definition,
    body.triggerEvent,
  );
  const triggerEvent = resolveSessionContinuationTrigger(
    ctx.tenantId,
    agent.id,
    body.sessionId,
    pinned,
    body.triggerEvent,
    requestedTriggerEvent,
  );
  const promptPort = studioPromptPort(pinned.definition);
  const suppliedInputs = await normalizeStudioFileReferences(
    ctx.tenantId,
    pinned.definition,
    body.inputs,
  );
  // Keep the operator-authored values separate from runtime enrichment. A
  // saved chat must not feed a previous turn's generated event/run ids back
  // as if the operator had authored them on the next turn.
  const authoredInputs: Record<string, unknown> = { ...suppliedInputs };
  if (promptPort) {
    // The exact textarea value is authoritative. A caller cannot smuggle a
    // different value into the authored prompt port through `inputs`.
    suppliedInputs[promptPort.id] = body.prompt;
  }
  // Allocate the durable identities before validation so compatibility-mode
  // payload schemas validate the exact runtime-owned fields they will receive.
  // A new session is not inserted until validation succeeds.
  const eventId = makeId("evt");
  const runId = makeId("run");
  const correlationId = makeId("cor");
  const preparedSessionId = body.sessionId ?? makeId("ars");
  const subject =
    typeof body.inputs.subject === "string" ? body.inputs.subject : null;
  const logicalTriggerPayload = buildStudioLogicalTriggerPayload({
    eventName: triggerEvent,
    eventId,
    runId,
    sessionId: preparedSessionId,
    correlationId,
    prompt: body.prompt,
    subject,
    authoredPayload: suppliedInputs.payload,
  });
  const legacyPayloadInput =
    normalizeAgentForExecution(pinned.definition).compatibilityMode === "v1" &&
    pinned.definition.inputs.some((input) => input.id === "payload");
  if (legacyPayloadInput) {
    // v1 definitions commonly render `{{json inputs.payload}}`. Give that
    // port the same canonical payload the generated prompt and ledger see.
    suppliedInputs.payload = logicalTriggerPayload;
  }
  const fileUploads = collectStudioFileUploads(
    pinned.definition,
    suppliedInputs,
  );
  try {
    // Validate before any row is queued or model/tool call is possible.
    await prepareAgentExecution({
      definition: pinned.definition,
      inputs: suppliedInputs,
    });
  } catch (error) {
    if (error instanceof AgentInputValidationError) {
      throw new StudioRunInputError(error.code, error.message, error.issues);
    }
    throw error;
  }

  const session = createSession(
    ctx,
    agent.id,
    body.sessionId,
    body.prompt.replace(/\s+/g, " ").trim() ||
      pinned.definition.title ||
      agent.name,
    preparedSessionId,
  );
  const queuedAt = new Date();
  const sideEffectMode =
    body.toolPolicy === "live"
      ? "live"
      : body.toolPolicy === "simulate"
        ? "suppressed"
        : "safe";
  const contextMode =
    options.conversationHistorySnapshot !== undefined
      ? "session"
      : (body.contextMode ?? "isolated");
  let conversationHistory =
    options.conversationHistorySnapshot !== undefined
      ? parseConversationHistorySnapshot(options.conversationHistorySnapshot)
      : [];
  const usageAttribution = currentUsageAttribution();
  getDb().transaction(() => {
    if (contextMode === "session") {
      const activeRun = getDb()
        .select({ id: runs.id })
        .from(runs)
        .where(
          and(
            eq(runs.tenantId, ctx.tenantId),
            eq(runs.sessionId, session.id),
            inArray(runs.status, ["queued", "running", "waiting"]),
          ),
        )
        .limit(1)
        .all()[0];
      if (activeRun) {
        throw new StudioRunInputError(
          "session_busy",
          "Wait for the active run in this conversation to finish before sending another message.",
          { runId: activeRun.id, sessionId: session.id },
        );
      }
      if (options.conversationHistorySnapshot === undefined) {
        // Snapshot before appending the current user message. This exact array
        // is persisted and dispatched so later session writes cannot alter it.
        conversationHistory = loadSessionConversationHistory(
          ctx.tenantId,
          session.id,
        );
      }
    }
    getDb()
      .insert(runs)
      .values({
        id: runId,
        tenantId: ctx.tenantId,
        agentId: agent.id,
        agentVersionId: pinned.agentVersionId,
        draftRevisionId: pinned.draftRevisionId,
        sessionId: session.id,
        triggerEventId: null,
        status: "queued",
        queuedAt,
        startedAt: null,
        correlationId,
        subject,
        invocationSource: options.source ?? "studio",
        requestedBy: ctx.userId ?? null,
        requestId: usageAttribution?.requestId,
        interactionId: usageAttribution?.interactionId,
        productSurface: usageAttribution?.productSurface,
        productAction: usageAttribution?.productAction,
        definitionHash: pinned.definitionHash,
        outputValid: null,
        sideEffectMode,
        isTest: true,
        logPath: logPathFor(
          { tenantSlug: ctx.tenantSlug, runId, correlationId },
          queuedAt,
        ),
      })
      .run();
    getDb()
      .update(agentRunSessions)
      .set({ updatedAt: queuedAt, lastRunAt: queuedAt })
      .where(eq(agentRunSessions.id, session.id))
      .run();
    appendSessionMessage(ctx.tenantId, session.id, runId, "user", {
      prompt: body.prompt,
      inputs: stripInlineFileData(
        Object.fromEntries(
          Object.entries(authoredInputs).filter(
            ([key]) => key !== promptPort?.id,
          ),
        ),
      ),
    });
  });

  const artifactRetention = retentionUntil(pinned.definition, queuedAt);
  const artifactSink = createDbArtifactSink(
    ctx.tenantId,
    runId,
    artifactRetention,
  );
  const trace = createStudioTraceSink(ctx.tenantId, runId, pinned.definition);
  const runtimeInputs: Record<string, unknown> = { ...suppliedInputs };
  const continuationInputs: Record<string, unknown> = { ...authoredInputs };
  try {
    await artifactSink.persist({
      role: "definition",
      logicalName: "agent-definition.json",
      contentType: "application/json",
      payload: pinned.definition,
      metadata: {
        definitionHash: pinned.definitionHash,
        target: body.target.kind,
        triggerEvent,
        contextMode,
        toolPolicy: body.toolPolicy,
        runtimeOverrides: body.runtimeOverrides ?? {},
      },
      retentionUntil: artifactRetention,
    });
    const uploadResults = new Map<
      Record<string, unknown>,
      Record<string, unknown>
    >();
    for (const upload of fileUploads) {
      const persisted = await artifactSink.persist({
        role: "attachment",
        logicalName: `${upload.port.id}-${upload.index + 1}-${upload.name}`,
        contentType: upload.contentType,
        payload: upload.bytes,
        schemaId: `agent-input:${upload.port.id}`,
        metadata: {
          inputPortId: upload.port.id,
          originalName: upload.name,
          sensitivity: upload.port.sensitivity,
        },
        retentionUntil: artifactRetention,
      });
      uploadResults.set(upload.original, {
        artifactId: persisted.id,
        name: upload.name,
        contentType: upload.contentType,
        size: persisted.size,
        sha256: persisted.sha256,
      });
    }
    for (const port of pinned.definition.inputs.filter(
      (input) => input.kind === "file",
    )) {
      const replaceUploads = (value: unknown): unknown => {
        if (Array.isArray(value)) {
          return value.map((item) =>
            item && typeof item === "object" && !Array.isArray(item)
              ? (uploadResults.get(item as Record<string, unknown>) ??
                stripInlineFileData(item))
              : item,
          );
        }
        if (value && typeof value === "object") {
          return (
            uploadResults.get(value as Record<string, unknown>) ??
            stripInlineFileData(value)
          );
        }
        return value;
      };
      runtimeInputs[port.id] = replaceUploads(runtimeInputs[port.id]);
      continuationInputs[port.id] = replaceUploads(continuationInputs[port.id]);
    }
    // Replace the provisional safe message inputs with the final artifact
    // references. A reopened conversation can now continue with the exact
    // structured inputs without retaining inline file bytes or stale names.
    getDb()
      .update(runMessages)
      .set({
        contentJson: {
          prompt: body.prompt,
          inputs: stripInlineFileData(
            Object.fromEntries(
              Object.entries(continuationInputs).filter(
                ([key]) => key !== promptPort?.id,
              ),
            ),
          ),
        } as never,
      })
      .where(
        and(
          eq(runMessages.tenantId, ctx.tenantId),
          eq(runMessages.runId, runId),
          eq(runMessages.role, "user"),
        ),
      )
      .run();
    if (
      pinned.definition.output_config.artifact.persist_run_input ||
      contextMode === "session"
    ) {
      const runInput: Record<string, unknown> = {
        ...runtimeInputs,
        prompt: body.prompt,
      };
      if (contextMode === "session") {
        runInput[STUDIO_CONVERSATION_HISTORY_METADATA_KEY] =
          conversationHistory;
      }
      await artifactSink.persist({
        role: "input",
        logicalName: "run-input.json",
        contentType: "application/json",
        // Keep the Studio chat prompt for exact replay even for human-only
        // definitions that intentionally do not expose an LLM prompt port.
        // Session-mode runs also reserve their exact bounded prior turns.
        payload: runInput,
        retentionUntil: artifactRetention,
      });
    }
    await trace.append({
      runId,
      kind: "run",
      level: "minimal",
      name: "run.queued",
      status: "pending",
      startedAt: queuedAt,
      summary: `Queued ${body.target.kind} Studio run`,
      data: {
        target: body.target.kind,
        definitionHash: pinned.definitionHash,
        eventId,
        eventName: triggerEvent,
        contextMode,
        conversationHistoryMessages: conversationHistory.length,
        toolPolicy: body.toolPolicy,
        runtimeOverrides: body.runtimeOverrides ?? {},
      },
      visibility: "user",
    });
    await writeRunLog(
      { tenantSlug: ctx.tenantSlug, runId, correlationId },
      "INFO",
      "run.queued",
      {
        agent_id: agent.id,
        target: body.target.kind,
        definition_hash: pinned.definitionHash,
        event_id: eventId,
        event_name: triggerEvent,
        context_mode: contextMode,
        conversation_history_messages: conversationHistory.length,
        tool_policy: body.toolPolicy,
        runtime_overrides: body.runtimeOverrides ?? {},
      },
    );
    const eventData = StudioAgentRunEventDataSchema.parse({
      schemaVersion: 1,
      eventId,
      eventName: triggerEvent,
      runId,
      sessionId: session.id,
      correlationId,
      agentId: agent.id,
      definitionHash: pinned.definitionHash,
      tenantId: ctx.tenantId,
      tenantSlug: ctx.tenantSlug,
      subject,
      // Never normalize or trim this value: it is the user-owned chat turn.
      prompt: body.prompt,
      payload: logicalTriggerPayload,
      // Includes the exact prompt under the definition's prompt-port id.
      inputs: runtimeInputs,
      conversationHistory,
      runtimeOverrides: body.runtimeOverrides ?? {},
      toolPolicy: body.toolPolicy,
    });
    const payloadRef = await appendToLedger(ctx.tenantSlug, {
      id: eventId,
      name: triggerEvent,
      ...(subject === null ? {} : { subject }),
      // Persist the authored logical event, never the private Studio control
      // envelope containing tenant, definition and tool-policy metadata.
      data: logicalTriggerPayload,
      ts: queuedAt.getTime(),
    });
    const eventCategory = getDb()
      .select({ category: eventTypes.category })
      .from(eventTypes)
      .where(
        and(
          eq(eventTypes.tenantId, ctx.tenantId),
          eq(eventTypes.name, triggerEvent),
        ),
      )
      .limit(1)
      .all()[0]?.category;
    getDb().transaction(() => {
      getDb()
        .insert(events)
        .values({
          id: eventId,
          tenantId: ctx.tenantId,
          name: triggerEvent,
          category: eventCategory ?? "studio",
          subject,
          payloadRef,
        })
        .run();
      const linked = getDb()
        .update(runs)
        .set({ triggerEventId: eventId })
        .where(
          and(
            eq(runs.id, runId),
            eq(runs.tenantId, ctx.tenantId),
            eq(runs.status, "queued"),
          ),
        )
        .run();
      if (linked.changes !== 1) {
        throw new StudioRunInputError(
          "run_dispatch_state_invalid",
          "The reserved Test Lab run was no longer queued for dispatch.",
          { runId },
        );
      }
    });
    await inngest.send({
      // Deliberately do not publish the live authored trigger as a second
      // Inngest event: that would execute both the live function and this
      // pinned draft-safe runner. The authored event identity lives in data.
      name: STUDIO_AGENT_RUN_CONTROL_EVENT,
      data: eventData,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await finalizeFailure({
      runId,
      tenantId: ctx.tenantId,
      tenantSlug: ctx.tenantSlug,
      definition: pinned.definition,
      startedAt: null,
      message: `dispatch_failed: ${message}`,
      code: "dispatch_failed",
    });
    throw new StudioRunInputError(
      "dispatch_failed",
      "The run was reserved but could not be dispatched. Its failed record remains in history.",
      { runId, cause: message },
    );
  }
  return {
    runId,
    sessionId: session.id,
    eventId,
    eventName: triggerEvent,
    status: "queued",
    definitionHash: pinned.definitionHash,
    traceUrl: `/v1/runs/${runId}/trace/stream`,
    outputUrl: `/v1/runs/${runId}/output`,
  };
}

function loadReservedRun(runId: string, tenantId: string) {
  const row = getDb()
    .select({ run: runs, agent: agents })
    .from(runs)
    .innerJoin(agents, eq(agents.id, runs.agentId))
    .where(and(eq(runs.id, runId), eq(runs.tenantId, tenantId)))
    .limit(1)
    .all()[0];
  if (!row) throw new Error(`reserved Studio run not found: ${runId}`);
  return row;
}

function loadRunDefinition(row: typeof runs.$inferSelect): AgentDefinitionV2 {
  if (row.draftRevisionId) {
    const revision = getDb()
      .select({ definition: agentDraftRevisions.definitionJson })
      .from(agentDraftRevisions)
      .where(eq(agentDraftRevisions.id, row.draftRevisionId))
      .limit(1)
      .all()[0];
    if (!revision) throw new Error("pinned draft revision is missing");
    return AgentDefinitionV2Schema.parse(revision.definition);
  }
  if (row.agentVersionId) {
    const version = getDb()
      .select({ definition: agentVersions.manifestJson })
      .from(agentVersions)
      .where(eq(agentVersions.id, row.agentVersionId))
      .limit(1)
      .all()[0];
    if (!version) throw new Error("pinned agent version is missing");
    return normalizeAgentDefinition(version.definition);
  }
  throw new Error("Studio run has no pinned draft or live agent version");
}

function studioToolAllowed(
  name: string,
  policy: "safe" | "simulate" | "live",
): boolean {
  if (policy === "live") return true;
  // Unknown tenant/MCP tools are deny-by-default in test runs until their
  // registry exposes an equivalent policy. Name heuristics are not a safe
  // side-effect boundary.
  const catalog = getGlobalToolCatalogEntry(name);
  if (!catalog || catalog.testPolicy !== "allow") return false;
  // The merged registry taxonomy is read | write | dual | call (no "none");
  // only read-class tools are side-effect-safe for non-live test runs.
  return policy === "safe" || catalog.sideEffect === "read";
}

function executionDefinition(
  definition: AgentDefinitionV2,
  policy: "safe" | "simulate" | "live",
  runtimeOverrides: Record<string, unknown>,
): AgentDefinitionV2 {
  const allowedTools =
    policy === "live"
      ? definition.tool_use
      : definition.tool_use.filter((tool) =>
          studioToolAllowed(tool.name, policy),
        );
  return AgentDefinitionV2Schema.parse({
    ...definition,
    tool_use: allowedTools,
    ...(typeof runtimeOverrides.provider === "string"
      ? { provider: runtimeOverrides.provider }
      : {}),
    ...(typeof runtimeOverrides.model === "string"
      ? { model: runtimeOverrides.model }
      : {}),
    ...(runtimeOverrides.reasoning &&
    typeof runtimeOverrides.reasoning === "object" &&
    !Array.isArray(runtimeOverrides.reasoning)
      ? { reasoning: runtimeOverrides.reasoning }
      : {}),
    ...(typeof runtimeOverrides.verbosity === "string"
      ? { verbosity: runtimeOverrides.verbosity }
      : {}),
    ...(typeof runtimeOverrides.store === "boolean"
      ? { store: runtimeOverrides.store }
      : {}),
    ...(typeof runtimeOverrides.temperature === "number"
      ? { temperature: runtimeOverrides.temperature }
      : {}),
    ...(typeof runtimeOverrides.maxTokens === "number"
      ? { max_tokens: runtimeOverrides.maxTokens }
      : {}),
    ...(typeof runtimeOverrides.timeoutS === "number"
      ? { timeout_s: runtimeOverrides.timeoutS }
      : {}),
  });
}

async function tenantRegistry(
  tenantSlug: string,
): Promise<TenantRegistry | undefined> {
  // Dynamic import avoids a bootstrap<->runner module cycle. The handler is
  // invoked only after bootstrap has populated the expanded registry cache.
  const module = await import("../bootstrap");
  return module.getExpandedTenantRegistry(tenantSlug);
}

async function terminalRecordMatches(
  tenantId: string,
  runId: string,
  status: "failed" | "cancelled",
): Promise<boolean> {
  const row = getDb()
    .select({ path: artifacts.path })
    .from(artifacts)
    .where(
      and(
        eq(artifacts.tenantId, tenantId),
        eq(artifacts.runId, runId),
        eq(artifacts.role, "run_record"),
      ),
    )
    .limit(1)
    .all()[0];
  if (!row) return false;
  try {
    const record = JSON.parse(await readFile(row.path, "utf8")) as {
      status?: unknown;
    };
    return record.status === status;
  } catch {
    return false;
  }
}

async function finalizeFailure(args: {
  runId: string;
  tenantId: string;
  definition: AgentDefinitionV2;
  startedAt?: Date | null;
  message: string;
  code?: string;
  tenantSlug?: string;
}): Promise<void> {
  let row = loadReservedRun(args.runId, args.tenantId).run;
  if (row.status === "ok") return;

  if (["queued", "running", "waiting"].includes(row.status)) {
    const endedAt = new Date();
    const startedAt = row.startedAt ?? args.startedAt ?? null;
    const durationMs = startedAt
      ? Math.max(0, endedAt.getTime() - startedAt.getTime())
      : 0;
    getDb()
      .update(runs)
      .set({
        status: "failed",
        endedAt,
        durationMs,
        outputValid: false,
        errorMessage: args.message,
      })
      .where(
        and(
          eq(runs.id, args.runId),
          eq(runs.tenantId, args.tenantId),
          inArray(runs.status, ["queued", "running", "waiting"]),
        ),
      )
      .run();
    row = loadReservedRun(args.runId, args.tenantId).run;
  }

  // A success or cancellation may win while the executor is unwinding. Never
  // let a stale exception rewrite that terminal state.
  if (row.status === "ok") return;
  if (row.status !== "failed" && row.status !== "cancelled") return;
  const status = row.status;
  if (await terminalRecordMatches(args.tenantId, args.runId, status)) return;
  const terminalCode =
    status === "cancelled"
      ? "run_cancelled"
      : (args.code ?? "execution_failed");
  const terminalMessage =
    status === "cancelled" ? "Studio run cancelled by operator." : args.message;

  const endedAt = row.endedAt ?? new Date();
  const startedAt = row.startedAt ?? args.startedAt ?? null;
  const durationMs =
    row.durationMs ??
    (startedAt ? Math.max(0, endedAt.getTime() - startedAt.getTime()) : 0);
  if (!row.endedAt || row.durationMs === null || row.outputValid !== false) {
    getDb()
      .update(runs)
      .set({ endedAt, durationMs, outputValid: false })
      .where(
        and(
          eq(runs.id, args.runId),
          eq(runs.tenantId, args.tenantId),
          eq(runs.status, status),
        ),
      )
      .run();
  }
  try {
    const trace = createStudioTraceSink(
      args.tenantId,
      args.runId,
      args.definition,
    );
    await trace.append({
      runId: args.runId,
      kind: "run",
      level: "minimal",
      name: "run.completed",
      status: "failed",
      ...(startedAt ? { startedAt } : {}),
      endedAt,
      durationMs,
      summary: terminalMessage,
      data: {
        code: terminalCode,
        terminalStatus: status,
      },
      visibility: "user",
    });
  } catch {
    // Terminal evidence persistence below remains authoritative even when the
    // structured trace store is temporarily unavailable.
  }
  if (args.tenantSlug) {
    await writeRunLog(
      {
        tenantSlug: args.tenantSlug,
        runId: args.runId,
        correlationId: row.correlationId,
      },
      status === "cancelled" ? "WARN" : "ERROR",
      status === "cancelled" ? "run.cancelled" : "run.failed",
      { status, error: terminalMessage, code: terminalCode },
    ).catch(() => undefined);
  }
  const artifacts = listRunArtifacts(args.tenantId, args.runId);
  const record: AgentRunRecord = {
    schemaVersion: 1,
    runId: args.runId,
    tenantId: args.tenantId,
    agentId: row.agentId,
    status,
    invocationSource: row.invocationSource,
    target: row.draftRevisionId
      ? { kind: "draft", draftRevisionId: row.draftRevisionId }
      : { kind: "live", agentVersionId: row.agentVersionId! },
    definitionHash: row.definitionHash ?? definitionHash(args.definition),
    sessionId: row.sessionId,
    correlationId: row.correlationId,
    subject: row.subject,
    validation: {
      inputValid: !args.message.startsWith("input_schema_invalid"),
      outputValid: false,
      issues: [],
    },
    artifacts,
    emittedEvents: [],
    timing: {
      queuedAt: row.queuedAt,
      startedAt,
      endedAt,
      durationMs,
    },
    error: {
      code: terminalCode,
      message: terminalMessage,
    },
  };
  try {
    await persistTerminalRunArtifacts({
      record,
      sink: createDbArtifactSink(
        args.tenantId,
        args.runId,
        runArtifactRetentionUntil(args.tenantId, args.runId, row.queuedAt),
      ),
    });
  } catch (error) {
    getDb()
      .update(runs)
      .set({
        errorMessage: `${row.errorMessage ?? terminalMessage}; run_record_persistence_failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      })
      .where(
        and(
          eq(runs.id, args.runId),
          eq(runs.tenantId, args.tenantId),
          eq(runs.status, status),
        ),
      )
      .run();
  }
  if (row.sessionId) {
    appendTerminalSessionMessageOnce(args.tenantId, row.sessionId, args.runId, {
      error: { code: terminalCode, message: terminalMessage },
    });
  }
}

export async function finalizeCancelledStudioRun(args: {
  tenantId: string;
  tenantSlug: string;
  runId: string;
}): Promise<void> {
  const row = loadReservedRun(args.runId, args.tenantId).run;
  if (row.invocationSource !== "studio" && row.invocationSource !== "replay") {
    return;
  }
  await finalizeFailure({
    ...args,
    definition: loadRunDefinition(row),
    startedAt: row.startedAt,
    message: "Studio run cancelled by operator.",
    code: "run_cancelled",
  });
}

export function buildStudioExecutionEvent(
  event: StudioAgentRunEventData,
  validatedInputs: Record<string, unknown>,
) {
  return {
    name: event.eventName,
    data: {
      // Match the public ingest path: authored payload fields live at the
      // event-data root. Named inputs stay in one sibling collection for v2
      // binding; the payload itself never contains that collection.
      ...event.payload,
      inputs: validatedInputs,
    },
  };
}

export async function executeReservedStudioRun(
  eventData: Record<string, unknown>,
) {
  const runId = typeof eventData.runId === "string" ? eventData.runId : "";
  const tenantId =
    typeof eventData.tenantId === "string" ? eventData.tenantId : "";
  const tenantSlug =
    typeof eventData.tenantSlug === "string" ? eventData.tenantSlug : "";
  const resolved = loadReservedRun(runId, tenantId);
  if (resolved.run.status !== "queued") {
    return {
      ok: false,
      runId,
      skipped: true,
      reason: `run_already_${resolved.run.status}`,
    };
  }
  let definition = loadRunDefinition(resolved.run);
  const startedAt = new Date();
  const claim = getDb()
    .update(runs)
    .set({ status: "running", startedAt })
    .where(and(eq(runs.id, runId), eq(runs.status, "queued")))
    .run();
  if (claim.changes !== 1) {
    return {
      ok: false,
      runId,
      skipped: true,
      reason: "run_claim_lost",
    };
  }
  const trace = createStudioTraceSink(tenantId, runId, definition);

  let lastResult: unknown = null;
  let tokensIn = 0;
  let tokensOut = 0;
  let model: string | null = null;
  let provider: string | null = null;
  let terminalRawResponse: string | undefined;
  try {
    const parsedEvent = StudioAgentRunEventDataSchema.safeParse(eventData);
    if (!parsedEvent.success) {
      throw new StudioRunInputError(
        "studio_event_invalid",
        "The durable Test Lab trigger payload is invalid.",
        parsedEvent.error.issues,
      );
    }
    const event = parsedEvent.data;
    const persistedTrigger = getDb()
      .select({ name: events.name, subject: events.subject })
      .from(events)
      .where(
        and(eq(events.id, event.eventId), eq(events.tenantId, event.tenantId)),
      )
      .limit(1)
      .all()[0];
    const logicalPayload = event.payload;
    const logicalSubject = logicalPayload.subject ?? null;
    const legacyPayloadMismatch =
      normalizeAgentForExecution(definition).compatibilityMode === "v1" &&
      definition.inputs.some((input) => input.id === "payload") &&
      canonicalJson(event.inputs.payload) !== canonicalJson(logicalPayload);
    const mismatch =
      event.runId !== resolved.run.id ||
      event.tenantId !== resolved.run.tenantId ||
      event.agentId !== resolved.agent.id ||
      event.sessionId !== resolved.run.sessionId ||
      event.correlationId !== resolved.run.correlationId ||
      event.definitionHash !== resolved.run.definitionHash ||
      event.eventId !== resolved.run.triggerEventId ||
      event.subject !== resolved.run.subject ||
      !persistedTrigger ||
      persistedTrigger.name !== event.eventName ||
      persistedTrigger.subject !== event.subject ||
      logicalPayload.event_type !== event.eventName ||
      logicalPayload.event_name !== event.eventName ||
      logicalPayload.event_id !== event.eventId ||
      logicalPayload.run_id !== event.runId ||
      logicalPayload.session_id !== event.sessionId ||
      logicalPayload.correlation_id !== event.correlationId ||
      logicalPayload.prompt !== event.prompt ||
      logicalPayload.input !== event.prompt ||
      logicalSubject !== event.subject ||
      legacyPayloadMismatch;
    if (mismatch) {
      throw new StudioRunInputError(
        "studio_event_mismatch",
        "The Test Lab trigger does not match its reserved run.",
        { runId },
      );
    }
    const declaredEventValid =
      definition.trigger.includes(event.eventName) ||
      (definition.trigger.length === 0 &&
        event.eventName === STUDIO_CHAT_MESSAGE_EVENT);
    if (!declaredEventValid) {
      throw new StudioRunInputError(
        "trigger_event_invalid",
        `Agent '${definition.name}' does not listen for '${event.eventName}'.`,
      );
    }
    const promptPort = studioPromptPort(definition);
    if (promptPort && event.inputs[promptPort.id] !== event.prompt) {
      throw new StudioRunInputError(
        "studio_prompt_mismatch",
        "The Test Lab trigger prompt does not match the authored prompt input.",
        { promptPortId: promptPort.id },
      );
    }
    definition = executionDefinition(
      definition,
      event.toolPolicy,
      event.runtimeOverrides,
    );
    await trace.append({
      runId,
      kind: "run",
      level: "minimal",
      name: "run.started",
      status: "running",
      startedAt,
      summary: `Executing ${definition.title ?? definition.name}`,
      data: {
        eventId: event.eventId,
        eventName: event.eventName,
        sessionId: event.sessionId,
        correlationId: event.correlationId,
      },
      visibility: "user",
    });
    await writeRunLog(
      { tenantSlug, runId, correlationId: resolved.run.correlationId },
      "INFO",
      "run.start",
      {
        agent: definition.name,
        definition_hash: resolved.run.definitionHash,
        event_id: event.eventId,
        event_name: event.eventName,
        session_id: event.sessionId,
      },
    ).catch(() => undefined);
    // Treat a malformed durable snapshot as a failed run. Silently dropping
    // corrupt history would make the execution differ from its input artifact.
    const conversationHistory = parseEventConversationHistory(
      event.conversationHistory,
    );
    const logicalEvent = buildStudioExecutionEvent(event, event.inputs);
    const executionInputs = bindTriggerInputs(definition, {
      ...logicalEvent,
      subject: event.subject,
    });
    if (promptPort) {
      // Trigger bindings may provide a production prompt template. In chat,
      // the current user turn is authoritative and cannot be replaced by it.
      executionInputs[promptPort.id] = event.prompt;
    }
    const prepared = await prepareAgentExecution({
      definition,
      inputs: executionInputs,
      trace,
      runId,
      promptOptions: {
        run: {
          subject: resolved.run.subject,
          correlationId: resolved.run.correlationId,
        },
      },
    });
    const registry = await tenantRegistry(event.tenantSlug);
    const artifactRetention = retentionUntil(definition, startedAt);
    let index = 0;
    let actionExecutions = 0;
    const maxActionExecutions = Math.max(100, definition.actions.length * 4);
    while (index < definition.actions.length) {
      actionExecutions += 1;
      if (actionExecutions > maxActionExecutions) {
        throw new StudioRunInputError(
          "action_loop_limit",
          `Studio stopped after ${maxActionExecutions} action executions to prevent an unbounded branch loop.`,
        );
      }
      const checkpoint = getDb()
        .select({ status: runs.status })
        .from(runs)
        .where(and(eq(runs.tenantId, tenantId), eq(runs.id, runId)))
        .limit(1)
        .all()[0];
      if (!checkpoint || checkpoint.status === "cancelled") {
        throw new StudioRunInputError(
          "run_cancelled",
          "Studio run cancelled before the next action checkpoint.",
        );
      }
      const action = definition.actions[index]!;
      const ord = actionExecutions;
      const stepId = makeId("stp");
      const stepStarted = new Date();
      getDb()
        .insert(steps)
        .values({
          id: stepId,
          runId,
          ord,
          name: action.name,
          type: action.type,
          status: "running",
          startedAt: stepStarted,
        })
        .run();

      if (
        action.type === "tool" &&
        !studioToolAllowed(action.tool ?? action.name, event.toolPolicy)
      ) {
        const message = `unsafe_tool_blocked: ${action.tool ?? action.name}`;
        getDb()
          .update(steps)
          .set({
            status: "failed",
            endedAt: new Date(),
            durationMs: 0,
            error: message,
          })
          .where(eq(steps.id, stepId))
          .run();
        throw new StudioRunInputError("unsafe_tool_blocked", message);
      }

      // Raw Studio actions legitimately carry per-action `retries` (the
      // step-engine honors it for raw/Studio-test actions); the parsed legacy
      // ActionSchema types `retries` as never-optional because the manifest
      // preprocessor promotes it to agent.retries. Cast across that seam.
      const executionAction = (
        action.type === "delay" ? { ...action, delay_ms: 0 } : action
      ) as Parameters<typeof runAction>[0]["action"];
      const executionEvent = buildStudioExecutionEvent(event, prepared.inputs);
      const outcome = await runAction({
        runId,
        stepId,
        stepOrd: ord,
        trace,
        ctx: {
          agentName: definition.name,
          actionName: action.name,
          subject: resolved.run.subject ?? undefined,
          correlationId: resolved.run.correlationId,
          tenantSlug: event.tenantSlug,
          event: executionEvent,
          lastResult,
        },
        action: executionAction,
        agent: {
          ...definition,
          tenantId,
          generated: definition.generated ?? true,
        },
        tenantRegistry: registry,
        conversationHistory,
        autoResolveManual: true,
        finalOutput: index === definition.actions.length - 1,
      });
      const stepEnded = new Date();
      getDb()
        .update(steps)
        .set({
          status: outcome.ok ? "ok" : "failed",
          endedAt: stepEnded,
          durationMs: Math.max(0, stepEnded.getTime() - stepStarted.getTime()),
          outputRef: outcome.outputArtifact ?? null,
          inputRef: outcome.outputArtifact
            ? outcome.outputArtifact.replace(/-output\.json$/, "-input.json")
            : null,
          error: outcome.ok
            ? null
            : String(
                (outcome.meta as { error?: unknown } | undefined)?.error ??
                  "step failed",
              ),
          provider: outcome.provider ?? null,
          model: outcome.model ?? null,
          tokensIn: outcome.tokensIn ?? 0,
          tokensOut: outcome.tokensOut ?? 0,
        })
        .where(eq(steps.id, stepId))
        .run();
      if (outcome.outputArtifact) {
        await registerExistingRunArtifact({
          tenantId,
          runId,
          stepId,
          role: "step_input",
          filePath: outcome.outputArtifact.replace(
            /-output\.json$/,
            "-input.json",
          ),
          retentionUntil: artifactRetention,
        });
        await registerExistingRunArtifact({
          tenantId,
          runId,
          stepId,
          role: "step_output",
          filePath: outcome.outputArtifact,
          retentionUntil: artifactRetention,
        });
      }
      tokensIn += outcome.tokensIn ?? 0;
      tokensOut += outcome.tokensOut ?? 0;
      model = outcome.model ?? model;
      provider = outcome.provider ?? provider;
      if (!outcome.ok) {
        throw new StudioRunInputError(
          String(
            (outcome.meta as { error?: unknown } | undefined)?.error ??
              "step_failed",
          ),
          `Step '${action.name}' failed.`,
          (outcome.meta as { validationIssues?: unknown } | undefined)
            ?.validationIssues,
        );
      }
      if (
        index === definition.actions.length - 1 &&
        typeof outcome.meta?.rawResponse === "string"
      ) {
        terminalRawResponse = outcome.meta.rawResponse;
      }
      lastResult = outcome.data;
      if (
        action.type === "manual" ||
        action.type === "delay" ||
        action.type === "subflow"
      ) {
        await trace.append({
          runId,
          stepId,
          kind: action.type === "subflow" ? "event" : "step",
          level: "standard",
          name: `${action.name}.studio_simulation`,
          status: "skipped",
          startedAt: stepEnded,
          endedAt: stepEnded,
          durationMs: 0,
          summary:
            action.type === "manual"
              ? "Human wait was auto-resolved for this Studio test run"
              : action.type === "delay"
                ? `Durable delay (${action.delay_ms ?? 0}ms) was skipped in Studio`
                : `Subflow '${action.subflow ?? "unknown"}' was suppressed in Studio test mode`,
          visibility: "user",
        });
      }
      if (action.type === "condition") {
        const evaluated =
          outcome.data &&
          typeof outcome.data === "object" &&
          (outcome.data as { evaluated?: unknown }).evaluated === true;
        const targetId = evaluated
          ? action.true_action_id
          : action.false_action_id;
        if (targetId) {
          const targetIndex = definition.actions.findIndex(
            (candidate) => (candidate.id ?? candidate.name) === targetId,
          );
          if (targetIndex < 0) {
            throw new StudioRunInputError(
              "condition_target_missing",
              `Condition '${action.name}' selected unknown action '${targetId}'.`,
            );
          }
          if (targetIndex <= index) {
            throw new StudioRunInputError(
              "condition_target_invalid",
              `Condition '${action.name}' must branch to a later action.`,
            );
          }
          await trace.append({
            runId,
            stepId,
            kind: "step",
            level: "standard",
            name: `${action.name}.branch`,
            status: "ok",
            startedAt: stepEnded,
            endedAt: stepEnded,
            durationMs: 0,
            summary: `Condition selected '${targetId}' (${evaluated ? "true" : "false"} branch)`,
            data: { evaluated, targetId },
            visibility: "user",
          });
          index = targetIndex;
          continue;
        }
      }
      index += 1;
    }

    const finalized = await finalizeAgentExecution({
      definition,
      candidate: lastResult,
      inputs: prepared.inputs,
      source: {
        agentName: definition.name,
        runId,
        subject: resolved.run.subject,
        correlationId: resolved.run.correlationId,
      },
      suppressEvents: true,
      trace,
      runId,
    });
    const beforeTerminal = getDb()
      .select({ status: runs.status })
      .from(runs)
      .where(and(eq(runs.tenantId, tenantId), eq(runs.id, runId)))
      .limit(1)
      .all()[0];
    if (!beforeTerminal || beforeTerminal.status !== "running") {
      throw new StudioRunInputError(
        "run_cancelled",
        "Studio run cancelled before terminal artifact persistence.",
      );
    }
    for (const emission of finalized.emissions) {
      await trace.append({
        runId,
        kind: "event",
        level: "standard",
        name: emission.name,
        status: "skipped",
        startedAt: new Date(),
        endedAt: new Date(),
        durationMs: 0,
        summary: `Suppressed downstream event '${emission.name}' in Studio test mode`,
        data: { outputPortIds: emission.outputPortIds },
        visibility: "user",
      });
    }
    const endedAt = new Date();
    const durationMs = Math.max(0, endedAt.getTime() - startedAt.getTime());
    const terminalSink = createDbArtifactSink(
      tenantId,
      runId,
      artifactRetention,
    );
    const persistedOutput = await terminalSink.persist({
      role: "output",
      logicalName: definition.output_config.artifact.filename,
      contentType: "application/json",
      payload: finalized.output.value,
      schemaId: "agent-output:aggregate",
      metadata: { aggregate: true },
      retentionUntil: artifactRetention,
    });
    if (definition.output_config.artifact.persist_individual_outputs) {
      const aggregate =
        finalized.output.value &&
        typeof finalized.output.value === "object" &&
        !Array.isArray(finalized.output.value)
          ? (finalized.output.value as Record<string, unknown>)
          : {};
      for (const port of definition.outputs) {
        const value = definition.output_config.unwrap_single_output
          ? finalized.output.value
          : aggregate[port.id];
        const proposedName = `output-${port.id}.json`;
        await terminalSink.persist({
          role: "output",
          logicalName:
            proposedName.toLowerCase() ===
            definition.output_config.artifact.filename.toLowerCase()
              ? `output-${port.id}-value.json`
              : proposedName,
          contentType: "application/json",
          payload: value ?? null,
          schemaId: `agent-output:${port.id}`,
          metadata: { outputPortId: port.id },
          retentionUntil: artifactRetention,
        });
      }
    }
    let persistedRawResponse:
      | Awaited<ReturnType<typeof terminalSink.persist>>
      | undefined;
    if (definition.output_config.artifact.persist_raw_response === true) {
      persistedRawResponse = await terminalSink.persist({
        role: "raw_response",
        logicalName: "raw-response.txt",
        contentType: "text/plain; charset=utf-8",
        payload: terminalRawResponse ?? finalized.output.rawResponse,
        retentionUntil: artifactRetention,
      });
    }
    const terminalInventory = listRunArtifacts(tenantId, runId);
    const record: AgentRunRecord = {
      schemaVersion: 1,
      runId,
      tenantId,
      agentId: resolved.run.agentId,
      status: "ok",
      invocationSource: resolved.run.invocationSource,
      target: resolved.run.draftRevisionId
        ? { kind: "draft", draftRevisionId: resolved.run.draftRevisionId }
        : { kind: "live", agentVersionId: resolved.run.agentVersionId! },
      definitionHash: resolved.run.definitionHash ?? definitionHash(definition),
      sessionId: resolved.run.sessionId,
      correlationId: resolved.run.correlationId,
      subject: resolved.run.subject,
      validation: {
        inputValid: true,
        outputValid: finalized.output.valid,
        issues: [],
      },
      artifacts: terminalInventory,
      emittedEvents: [],
      model: {
        ...(provider ? { provider: provider as never } : {}),
        ...(model ? { model } : {}),
        tokensIn,
        tokensOut,
      },
      timing: {
        queuedAt: resolved.run.queuedAt,
        startedAt,
        endedAt,
        durationMs,
      },
      error: null,
    };
    const persistedRunRecord = await terminalSink.persist({
      role: "run_record",
      logicalName: "run-record.json",
      contentType: "application/json",
      payload: record,
      retentionUntil: artifactRetention,
    });
    const completed = getDb()
      .update(runs)
      .set({
        status: "ok",
        endedAt,
        durationMs,
        tokensIn,
        tokensOut,
        provider,
        model,
        outputValid: finalized.output.valid,
      })
      .where(and(eq(runs.id, runId), eq(runs.status, "running")))
      .run();
    if (completed.changes !== 1) {
      throw new StudioRunInputError(
        "run_cancelled",
        "Studio run was cancelled while terminal artifacts were being persisted.",
      );
    }
    if (resolved.run.sessionId) {
      appendTerminalSessionMessageOnce(
        tenantId,
        resolved.run.sessionId,
        runId,
        finalized.output.value,
      );
    }
    try {
      await trace.append({
        runId,
        kind: "artifact",
        level: "standard",
        name: "output.persisted",
        status: "ok",
        startedAt: endedAt,
        endedAt,
        durationMs: 0,
        summary: "Validated output and run-record.json were persisted",
        data: {
          outputArtifactId: persistedOutput.id,
          rawResponseArtifactId: persistedRawResponse?.id,
          runRecordArtifactId: persistedRunRecord.id,
        },
        artifactId: persistedOutput.id,
        visibility: "user",
      });
      await trace.append({
        runId,
        kind: "run",
        level: "minimal",
        name: "run.completed",
        status: "ok",
        startedAt,
        endedAt,
        durationMs,
        summary: "Studio run completed with JSON output",
        data: { tokensIn, tokensOut, provider, model },
        visibility: "user",
      });
    } catch {
      // The run is already durably successful. Trace/session presentation
      // failures must never reverse the terminal state.
    }
    await writeRunLog(
      { tenantSlug, runId, correlationId: resolved.run.correlationId },
      "INFO",
      "run.complete",
      {
        status: "ok",
        duration_ms: durationMs,
        tokens_in: tokensIn,
        tokens_out: tokensOut,
      },
    ).catch(() => undefined);
    return { ok: true, runId, outputArtifactId: persistedOutput.id };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await finalizeFailure({
      runId,
      tenantId,
      definition,
      startedAt,
      message,
      code:
        error instanceof StudioRunInputError
          ? error.code
          : error instanceof ArtifactPersistenceError
            ? error.code
            : "execution_failed",
      tenantSlug,
    });
    throw error;
  }
}

export const studioRunnerFn: InngestFunction.Any = inngest.createFunction(
  {
    id: "agent-studio-runner",
    name: "Agent Studio runner",
    // The Studio runner claims a reserved run once and may execute live tools;
    // automatic whole-function retries would duplicate side effects. Action-
    // level retries remain governed by the authored runtime/action policy.
    retries: 0,
    concurrency: { limit: 20, key: "event.data.tenantId" },
    triggers: [{ event: STUDIO_AGENT_RUN_CONTROL_EVENT }],
  },
  async ({ event, step }) =>
    step.run("execute-reserved-studio-run", () =>
      executeReservedStudioRun((event.data ?? {}) as Record<string, unknown>),
    ),
);

export function getRunSession(
  tenantId: string,
  sessionId: string,
): AgentRunSession | null {
  return (
    getDb()
      .select()
      .from(agentRunSessions)
      .where(
        and(
          eq(agentRunSessions.tenantId, tenantId),
          eq(agentRunSessions.id, sessionId),
        ),
      )
      .limit(1)
      .all()[0] ?? null
  );
}

export async function replayStudioRun(
  ctx: AuthedContext,
  runId: string,
  body: ReplayStudioRunBody,
): Promise<CreateAgentRunResponse> {
  const original = getDb()
    .select({ run: runs, agent: agents, triggerEventName: events.name })
    .from(runs)
    .innerJoin(agents, eq(agents.id, runs.agentId))
    .leftJoin(events, eq(events.id, runs.triggerEventId))
    .where(and(eq(runs.tenantId, ctx.tenantId), eq(runs.id, runId)))
    .limit(1)
    .all()[0];
  if (
    !original ||
    !["studio", "replay"].includes(original.run.invocationSource)
  ) {
    throw new AgentStudioNotFoundError("agent");
  }
  const inputArtifact = getDb()
    .select({
      path: artifacts.path,
      retentionUntil: artifacts.retentionUntil,
    })
    .from(artifacts)
    .where(
      and(
        eq(artifacts.tenantId, ctx.tenantId),
        eq(artifacts.runId, runId),
        eq(artifacts.role, "input"),
      ),
    )
    .limit(1)
    .all()[0];
  if (!inputArtifact) {
    throw new StudioRunInputError(
      "replay_input_missing",
      "The original run input artifact is unavailable.",
    );
  }
  if (
    inputArtifact.retentionUntil &&
    inputArtifact.retentionUntil.getTime() <= Date.now()
  ) {
    throw new StudioRunInputError(
      "replay_input_expired",
      "The original run input artifact has expired.",
    );
  }
  let stored: Record<string, unknown>;
  try {
    stored = JSON.parse(await readFile(inputArtifact.path, "utf8")) as Record<
      string,
      unknown
    >;
  } catch {
    throw new StudioRunInputError(
      "replay_input_missing",
      "The original run input artifact cannot be read.",
    );
  }
  const hasConversationSnapshot = Object.hasOwn(
    stored,
    STUDIO_CONVERSATION_HISTORY_METADATA_KEY,
  );
  const conversationHistorySnapshot = hasConversationSnapshot
    ? parseConversationHistorySnapshot(
        stored[STUDIO_CONVERSATION_HISTORY_METADATA_KEY],
      )
    : undefined;
  const storedInputs = { ...stored };
  const inputsPatch = { ...body.inputsPatch };
  delete storedInputs[STUDIO_CONVERSATION_HISTORY_METADATA_KEY];
  // Reserved execution metadata always comes from the original artifact. A
  // replay input patch cannot replace conversation history with mutable or
  // caller-supplied turns.
  delete inputsPatch[STUDIO_CONVERSATION_HISTORY_METADATA_KEY];
  const patched = { ...storedInputs, ...inputsPatch };
  const prompt =
    typeof patched.prompt === "string"
      ? patched.prompt
      : String(stored.prompt ?? "");
  delete patched.prompt;
  if (!prompt.trim()) {
    throw new StudioRunInputError(
      "replay_prompt_missing",
      "The replay input does not contain a usable prompt.",
    );
  }

  let target: CreateAgentRunBody["target"];
  if (body.version === "latest") {
    target = { kind: "live" };
  } else if (original.run.draftRevisionId) {
    const revision = getDb()
      .select({
        draftId: agentDraftRevisions.draftId,
        revision: agentDraftRevisions.revision,
      })
      .from(agentDraftRevisions)
      .where(
        and(
          eq(agentDraftRevisions.tenantId, ctx.tenantId),
          eq(agentDraftRevisions.id, original.run.draftRevisionId),
        ),
      )
      .limit(1)
      .all()[0];
    if (!revision) {
      throw new StudioRunInputError(
        "replay_version_missing",
        "The original draft revision is unavailable.",
      );
    }
    target = {
      kind: "draft",
      draftId: revision.draftId,
      revision: revision.revision,
    };
  } else if (original.run.agentVersionId) {
    target = {
      kind: "live",
      agentVersionId: original.run.agentVersionId,
    };
  } else {
    throw new StudioRunInputError(
      "replay_version_missing",
      "The original run has no pinned definition version.",
    );
  }

  const toolPolicy =
    original.run.sideEffectMode === "live"
      ? "live"
      : original.run.sideEffectMode === "suppressed"
        ? "simulate"
        : "safe";
  return reserveStudioRun(
    ctx,
    original.agent.id,
    {
      sessionId: body.sessionId ?? original.run.sessionId ?? undefined,
      contextMode:
        conversationHistorySnapshot === undefined ? "isolated" : "session",
      target,
      ...(original.triggerEventName &&
      original.triggerEventName !== STUDIO_CHAT_MESSAGE_EVENT
        ? { triggerEvent: original.triggerEventName }
        : {}),
      prompt,
      inputs: patched,
      toolPolicy,
    },
    {
      source: "replay",
      ...(conversationHistorySnapshot === undefined
        ? {}
        : { conversationHistorySnapshot }),
    },
  );
}
