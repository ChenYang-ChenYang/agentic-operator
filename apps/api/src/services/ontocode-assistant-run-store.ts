import { createHash, randomUUID } from "node:crypto";
import { and, asc, desc, eq } from "drizzle-orm";
import {
  getDb,
  ontocodeAssistantRuns,
  ontocodeAssistantSteps,
  ontocodePinnedContextRefs,
  ontocodeSessionEvents,
  ontocodeSessionMessages,
  ontocodeSessions,
  tenantScope,
} from "@agentic/db";
import { canonicalEvidenceJson } from "@agentic/shared";
import { redactSecretRuns } from "@agentic/agent-factory";
import {
  OntoCodeAssistantRunSchema,
  OntoCodeAssistantStepSchema,
  OntoCodeMessageSchema,
  OntoCodePinnedContextRefSchema,
  type OntoCodeAssistantRun,
  type OntoCodeAssistantStep,
  type OntoCodeBuildSession,
  type OntoCodeMessage,
  type OntoCodePinnedContextRef,
} from "@agentic/contracts";
import type { OntoCodeCompiledContext } from "./ontocode-context-compiler";
import {
  resolveOntoCodeAssistantTurnBudget,
  type OntoCodeAssistantTurnBudget,
} from "./ontocode-assistant-inquiry";
import {
  getOntoCodeSession,
  OntoCodeStoreError,
  type OntoCodeStoreContext,
  type Page,
} from "./ontocode-session-store";

type Db = ReturnType<typeof getDb>;
type Transaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * #ASSISTANT-BUDGET —— 声明的预算就是**被执行的那一个**。
 *
 * 2026-08-04 实测：落库的 run 行与 `assistant.run.accepted` 帧写着
 * `{maxModelCalls:3, maxTokens:8000, maxToolCalls:20}`，同一轮实际跑了 5 次调用、
 * 96_507 token —— 这里四个数字全是装饰，没有任何代码读过它们，而真正在跑的是
 * `resolveOntoCodeAssistantTurnBudget()` 里另一套完全不同的默认值。
 *
 * 所以这里不再有自己的字面量：它调用**执行方读的同一个函数**。两处数字打架的
 * 唯一根治办法是让它们物理上是同一个数字。
 */
function assistantBudget(): OntoCodeAssistantTurnBudget {
  return resolveOntoCodeAssistantTurnBudget();
}

function makeId(prefix: string): string {
  return `${prefix}-${randomUUID().replaceAll("-", "").slice(0, 16)}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function timestamp(value: Date | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.getTime() : Number(value);
}

function requiredTimestamp(
  value: Date | number | null | undefined,
  field: string,
): number {
  const result = timestamp(value);
  if (result === null || !Number.isFinite(result)) {
    throw new OntoCodeStoreError(
      "ontocode_data_corrupt",
      `OntoCode Assistant row has an invalid ${field}`,
      500,
    );
  }
  return result;
}

function parseJson(value: string, field: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new OntoCodeStoreError(
      "ontocode_data_corrupt",
      `OntoCode Assistant row has invalid JSON in ${field}`,
      500,
    );
  }
}

function runFromRow(
  row: typeof ontocodeAssistantRuns.$inferSelect,
): OntoCodeAssistantRun {
  return OntoCodeAssistantRunSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    sessionId: row.sessionId,
    sourceMessageId: row.sourceMessageId,
    status: row.status,
    autonomyMode: row.autonomyMode,
    policy: parseJson(row.policyJson, "assistantRun.policyJson"),
    contextHash: row.contextHash ?? null,
    contextManifest: parseJson(
      row.contextManifestJson,
      "assistantRun.contextManifestJson",
    ),
    budget: parseJson(row.budgetJson, "assistantRun.budgetJson"),
    model: row.model ?? null,
    terminalResponse:
      row.terminalResponseJson === null
        ? null
        : parseJson(
            row.terminalResponseJson,
            "assistantRun.terminalResponseJson",
          ),
    errorCode: row.errorCode ?? null,
    errorMessage: row.errorMessage ?? null,
    idempotencyKey: row.idempotencyKey,
    createdBy: row.createdBy ?? null,
    createdAt: requiredTimestamp(row.createdAt, "createdAt"),
    startedAt: timestamp(row.startedAt),
    finishedAt: timestamp(row.finishedAt),
    updatedAt: requiredTimestamp(row.updatedAt, "updatedAt"),
  });
}

function stepFromRow(
  row: typeof ontocodeAssistantSteps.$inferSelect,
): OntoCodeAssistantStep {
  return OntoCodeAssistantStepSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    sessionId: row.sessionId,
    assistantRunId: row.assistantRunId,
    ordinal: row.ordinal,
    kind: row.kind,
    status: row.status,
    attempt: row.attempt,
    inputHash: row.inputHash ?? null,
    outputHash: row.outputHash ?? null,
    observation: parseJson(
      row.observationJson,
      "assistantStep.observationJson",
    ),
    errorCode: row.errorCode ?? null,
    errorMessage: row.errorMessage ?? null,
    createdAt: requiredTimestamp(row.createdAt, "createdAt"),
    startedAt: requiredTimestamp(row.startedAt, "startedAt"),
    finishedAt: timestamp(row.finishedAt),
    updatedAt: requiredTimestamp(row.updatedAt, "updatedAt"),
  });
}

function pinnedRefFromRow(
  row: typeof ontocodePinnedContextRefs.$inferSelect,
): OntoCodePinnedContextRef {
  return OntoCodePinnedContextRefSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    sessionId: row.sessionId,
    assistantRunId: row.assistantRunId,
    ordinal: row.ordinal,
    kind: row.kind,
    requestedRef: row.requestedRef,
    canonicalRef: row.canonicalRef,
    artifactId: row.artifactId ?? null,
    artifactVersionId: row.artifactVersionId ?? null,
    evidenceId: row.evidenceId ?? null,
    changeSetId: row.changeSetId ?? null,
    contentHash: row.contentHash,
    metadata: parseJson(row.metadataJson, "pinnedContextRef.metadataJson"),
    createdAt: requiredTimestamp(row.createdAt, "createdAt"),
  });
}

function messageFromRow(
  row: typeof ontocodeSessionMessages.$inferSelect,
): OntoCodeMessage {
  return OntoCodeMessageSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    sessionId: row.sessionId,
    role: row.role,
    type: row.type,
    content: parseJson(row.contentJson, "assistantSourceMessage.contentJson"),
    commandId: row.commandId ?? null,
    correlationId: row.correlationId,
    idempotencyKey: row.idempotencyKey ?? null,
    createdAt: requiredTimestamp(row.createdAt, "createdAt"),
  });
}

function nextEventSeq(
  tx: Transaction,
  tenantId: string,
  sessionId: string,
): number {
  const latest = tx
    .select({ seq: ontocodeSessionEvents.seq })
    .from(ontocodeSessionEvents)
    .where(
      and(
        eq(ontocodeSessionEvents.tenantId, tenantId),
        eq(ontocodeSessionEvents.sessionId, sessionId),
      ),
    )
    .orderBy(desc(ontocodeSessionEvents.seq))
    .limit(1)
    .get();
  return (latest?.seq ?? 0) + 1;
}

function appendAssistantEvent(
  tx: Transaction,
  input: {
    tenantId: string;
    projectId: string;
    sessionId: string;
    type: string;
    payload: Record<string, unknown>;
    correlationId: string;
    causationId: string;
    now: Date;
    visibility?: "user" | "debug" | "audit";
  },
): void {
  tx.insert(ontocodeSessionEvents)
    .values({
      id: makeId("oce"),
      tenantId: input.tenantId,
      projectId: input.projectId,
      sessionId: input.sessionId,
      seq: nextEventSeq(tx, input.tenantId, input.sessionId),
      type: input.type,
      visibility: input.visibility ?? "audit",
      payloadJson: canonicalEvidenceJson(input.payload),
      commandId: null,
      harnessJobId: null,
      correlationId: input.correlationId,
      causationId: input.causationId,
      createdAt: input.now,
    })
    .run();
}

export interface OntoCodeAssistantRunAcceptance {
  run: OntoCodeAssistantRun;
  sourceMessage: OntoCodeMessage;
  sessionRevision: number;
  mode: "created" | "attached";
}

/**
 * #TURN-REDACT — inline secrets in a chat turn, removed before the turn becomes
 * durable.
 *
 * The configuration flow refuses a pasted secret and names the env var instead,
 * but that gate runs on the PLAN — and this function persists the raw turn
 * BEFORE the model is ever called. Both things were true at once: the refusal
 * was real and the value was already in `ontocode_session_messages`.
 *
 * `sanitizeSensitiveInput` alone is not enough here: it judges whole values
 * ("is this string secret-shaped?"), while a chat turn is a SENTENCE with a
 * secret inside it. So a text pass runs first, using the same patterns the API
 * log redactor and the probe evidence redactor already use, and env-reference
 * NAMES are deliberately preserved — the name is exactly what the FDE needs to
 * see and act on.
 */
/**
 * `scheme://user:password@host` — keep the parts that help the FDE (scheme,
 * user, host) and drop only the secret. Kept alongside the shared vocabulary
 * because the shared pattern masks the whole prefix, and here the surrounding
 * identity is the useful part.
 */
const TURN_URL_CREDENTIAL_RE =
  /\b([a-z][a-z0-9+.-]*:\/\/)([^:@\s/]+):([^@\s]+?)@/gi;

export function redactOntoCodeTurnText(value: string): string {
  // The shared secret vocabulary first — a hand-rolled list here was strictly
  // narrower and let PEM blocks, `Bearer` tokens, AWS key ids and `Password=…`
  // through while masking an `sk-` key beside them.
  return redactSecretRuns(
    value.replace(
      TURN_URL_CREDENTIAL_RE,
      (_m, scheme: string, user: string) => `${scheme}${user}:[REDACTED_SECRET]@`,
    ),
  );
}

export function acceptOntoCodeAssistantRun(
  ctx: OntoCodeStoreContext,
  sessionId: string,
  input: {
    text: string;
    contextRefs: string[];
    idempotencyKey: string;
  },
): OntoCodeAssistantRunAcceptance {
  // Built ONCE and used both for the durable write and for the idempotency
  // re-comparison. Redacting here (rather than at the write) is what keeps a
  // replayed turn matching instead of looking like a new one.
  const expectedContent = {
    text: redactOntoCodeTurnText(input.text),
    turn: {
      behavior: "assistant",
      contextRefs: input.contextRefs,
    },
  };
  return getDb().transaction((tx) => {
    const sessionRow = tx
      .select()
      .from(ontocodeSessions)
      .where(
        tenantScope(ctx, ontocodeSessions)(eq(ontocodeSessions.id, sessionId)),
      )
      .get();
    if (!sessionRow) {
      throw new OntoCodeStoreError(
        "ontocode_session_not_found",
        "OntoCode build session not found",
        404,
      );
    }
    if (
      sessionRow.activityState === "cancelled" ||
      sessionRow.phase === "completed"
    ) {
      throw new OntoCodeStoreError(
        "ontocode_session_read_only",
        "This OntoCode Session no longer accepts Assistant turns",
        409,
      );
    }

    const existingRunRow = tx
      .select()
      .from(ontocodeAssistantRuns)
      .where(
        tenantScope(
          ctx,
          ontocodeAssistantRuns,
        )(
          and(
            eq(ontocodeAssistantRuns.sessionId, sessionId),
            eq(ontocodeAssistantRuns.idempotencyKey, input.idempotencyKey),
          ),
        ),
      )
      .get();
    if (existingRunRow) {
      const sourceRow = tx
        .select()
        .from(ontocodeSessionMessages)
        .where(
          tenantScope(
            ctx,
            ontocodeSessionMessages,
          )(eq(ontocodeSessionMessages.id, existingRunRow.sourceMessageId)),
        )
        .get();
      if (
        !sourceRow ||
        sourceRow.role !== "user" ||
        canonicalEvidenceJson(
          parseJson(sourceRow.contentJson, "sourceMessage.contentJson"),
        ) !== canonicalEvidenceJson(expectedContent)
      ) {
        throw new OntoCodeStoreError(
          "ontocode_idempotency_conflict",
          "This idempotency key was already used for a different Assistant turn",
          409,
        );
      }
      return {
        run: runFromRow(existingRunRow),
        sourceMessage: messageFromRow(sourceRow),
        sessionRevision: sessionRow.revision,
        mode: "attached",
      };
    }

    const now = new Date();
    const correlationId = makeId("cor");
    const messageId = makeId("ocm");
    const messageRow: typeof ontocodeSessionMessages.$inferInsert = {
      id: messageId,
      tenantId: ctx.tenantId,
      sessionId,
      role: "user",
      type: "text",
      contentJson: canonicalEvidenceJson(expectedContent),
      idempotencyKey: input.idempotencyKey,
      commandId: null,
      correlationId,
      createdAt: now,
    };
    tx.insert(ontocodeSessionMessages).values(messageRow).run();

    const runId = makeId("ocar");
    const runRow: typeof ontocodeAssistantRuns.$inferInsert = {
      id: runId,
      tenantId: ctx.tenantId,
      sessionId,
      sourceMessageId: messageId,
      status: "accepted",
      autonomyMode: sessionRow.autonomyMode,
      policyJson: canonicalEvidenceJson({
        schema: "ontocode-assistant-policy/v1",
        autonomyMode: sessionRow.autonomyMode,
        autonomySemantics:
          sessionRow.autonomyMode === "guide"
            ? "analysis_only"
            : sessionRow.autonomyMode === "copilot"
              ? "confirm_each_non_read_only_step"
              : "sandbox_autonomous",
        commandPolicy: "server_derived",
        externalWrites: "human_gated",
        hiddenReasoningStored: false,
      }),
      contextHash: null,
      contextManifestJson: "{}",
      budgetJson: canonicalEvidenceJson(assistantBudget()),
      model: null,
      terminalResponseJson: null,
      errorCode: null,
      errorMessage: null,
      idempotencyKey: input.idempotencyKey,
      createdBy: ctx.actorId,
      createdAt: now,
      startedAt: null,
      finishedAt: null,
      updatedAt: now,
    };
    tx.insert(ontocodeAssistantRuns).values(runRow).run();

    const revision = sessionRow.revision + 1;
    const updated = tx
      .update(ontocodeSessions)
      .set({
        revision,
        activityState: "ai_planning",
        updatedAt: now,
      })
      .where(
        tenantScope(
          ctx,
          ontocodeSessions,
        )(
          and(
            eq(ontocodeSessions.id, sessionId),
            eq(ontocodeSessions.revision, sessionRow.revision),
          ),
        ),
      )
      .run();
    if (updated.changes !== 1) {
      throw new OntoCodeStoreError(
        "ontocode_session_revision_conflict",
        "The OntoCode Session changed while accepting the Assistant turn",
        409,
      );
    }

    appendAssistantEvent(tx, {
      tenantId: ctx.tenantId,
      projectId: sessionRow.projectId,
      sessionId,
      type: "session.message.appended",
      payload: {
        message: messageFromRow(
          messageRow as typeof ontocodeSessionMessages.$inferSelect,
        ),
        turnBehavior: "assistant",
      },
      correlationId,
      causationId: messageId,
      now,
      visibility: "user",
    });
    appendAssistantEvent(tx, {
      tenantId: ctx.tenantId,
      projectId: sessionRow.projectId,
      sessionId,
      type: "assistant.run.accepted",
      payload: {
        assistantRunId: runId,
        sourceMessageId: messageId,
        autonomyMode: sessionRow.autonomyMode,
        budget: assistantBudget(),
      },
      correlationId,
      causationId: runId,
      now,
      // Only `assistant.run.failed` was ever visible below the audit tier, so a
      // reasoning lane could show that a turn broke and never that one started
      // or finished: every successful run read as though nothing happened.
      visibility: "debug",
    });

    return {
      run: runFromRow(runRow as typeof ontocodeAssistantRuns.$inferSelect),
      sourceMessage: messageFromRow(
        messageRow as typeof ontocodeSessionMessages.$inferSelect,
      ),
      sessionRevision: revision,
      mode: "created",
    };
  });
}

/**
 * #ASSISTANT-PROGRESS —— 把一条对话推理过程帧变成 durable 行。
 *
 * 独立事务、逐帧提交：**不能**挂在受理事务或任何长事务上。挂上去就要等整轮
 * 结束才可见，那等于没流——屏幕上仍然是一段空白，只是空白结束时一次性掉下来
 * 六行。这里每写完一帧就提交一帧，SSE 与 REST 立刻能读到它。
 *
 * `visibility` 恒为 debug，与既有的 `assistant.run.*` 一致：`audit` 会被 REST
 * 与 SSE 双双挡掉，`user` 则会把过程混进对话正文。
 *
 * `assistantRunId` 与 `sourceMessageId` 提到 payload **顶层**，因为前端把事件
 * 归到哪条泳道只读顶层字段、不递归——嵌一层就落进兜底泳道。
 */
export function appendOntoCodeAssistantProgress(
  ctx: Pick<OntoCodeStoreContext, "tenantId">,
  input: {
    runId: string;
    type: string;
    payload: Record<string, unknown>;
  },
): void {
  getDb().transaction((tx) => {
    const runRow = tx
      .select({
        sessionId: ontocodeAssistantRuns.sessionId,
        sourceMessageId: ontocodeAssistantRuns.sourceMessageId,
      })
      .from(ontocodeAssistantRuns)
      .where(
        tenantScope(
          ctx,
          ontocodeAssistantRuns,
        )(eq(ontocodeAssistantRuns.id, input.runId)),
      )
      .get();
    if (!runRow) {
      throw new OntoCodeStoreError(
        "ontocode_assistant_run_not_found",
        "OntoCode Assistant Run not found",
        404,
      );
    }
    const session = tx
      .select({ projectId: ontocodeSessions.projectId })
      .from(ontocodeSessions)
      .where(
        tenantScope(
          ctx,
          ontocodeSessions,
        )(eq(ontocodeSessions.id, runRow.sessionId)),
      )
      .get();
    if (!session) {
      throw new OntoCodeStoreError(
        "ontocode_session_not_found",
        "OntoCode build session not found",
        404,
      );
    }
    appendAssistantEvent(tx, {
      tenantId: ctx.tenantId,
      projectId: session.projectId,
      sessionId: runRow.sessionId,
      type: input.type,
      payload: {
        assistantRunId: input.runId,
        sourceMessageId: runRow.sourceMessageId,
        ...input.payload,
      },
      correlationId: `ocar-${input.runId}`,
      causationId: input.runId,
      now: new Date(),
      visibility: "debug",
    });
  });
}

export function startOntoCodeAssistantStep(
  ctx: OntoCodeStoreContext,
  runId: string,
  input: {
    ordinal: number;
    kind: OntoCodeAssistantStep["kind"];
    input: unknown;
  },
): OntoCodeAssistantStep {
  return getDb().transaction((tx) => {
    const runRow = tx
      .select()
      .from(ontocodeAssistantRuns)
      .where(
        tenantScope(
          ctx,
          ontocodeAssistantRuns,
        )(eq(ontocodeAssistantRuns.id, runId)),
      )
      .get();
    if (!runRow) {
      throw new OntoCodeStoreError(
        "ontocode_assistant_run_not_found",
        "OntoCode Assistant Run not found",
        404,
      );
    }
    const existing = tx
      .select()
      .from(ontocodeAssistantSteps)
      .where(
        tenantScope(
          ctx,
          ontocodeAssistantSteps,
        )(
          and(
            eq(ontocodeAssistantSteps.assistantRunId, runId),
            eq(ontocodeAssistantSteps.ordinal, input.ordinal),
          ),
        ),
      )
      .get();
    if (existing) {
      if (
        existing.kind !== input.kind ||
        existing.inputHash !== sha256(canonicalEvidenceJson(input.input))
      ) {
        throw new OntoCodeStoreError(
          "ontocode_assistant_step_conflict",
          "This Assistant Step ordinal already represents a different operation",
          409,
        );
      }
      return stepFromRow(existing);
    }
    if (
      runRow.status === "succeeded" ||
      runRow.status === "failed" ||
      runRow.status === "cancelled"
    ) {
      throw new OntoCodeStoreError(
        "ontocode_assistant_run_terminal",
        "A terminal Assistant Run cannot start another Step",
        409,
      );
    }

    const now = new Date();
    const stepRow: typeof ontocodeAssistantSteps.$inferInsert = {
      id: makeId("ocas"),
      tenantId: ctx.tenantId,
      sessionId: runRow.sessionId,
      assistantRunId: runId,
      ordinal: input.ordinal,
      kind: input.kind,
      status: "running",
      attempt: 1,
      inputHash: sha256(canonicalEvidenceJson(input.input)),
      outputHash: null,
      observationJson: "{}",
      errorCode: null,
      errorMessage: null,
      createdAt: now,
      startedAt: now,
      finishedAt: null,
      updatedAt: now,
    };
    tx.insert(ontocodeAssistantSteps).values(stepRow).run();
    tx.update(ontocodeAssistantRuns)
      .set({
        status: "planning",
        startedAt: runRow.startedAt ?? now,
        updatedAt: now,
      })
      .where(
        tenantScope(
          ctx,
          ontocodeAssistantRuns,
        )(eq(ontocodeAssistantRuns.id, runId)),
      )
      .run();
    return stepFromRow(stepRow as typeof ontocodeAssistantSteps.$inferSelect);
  });
}

export function completeOntoCodeAssistantStep(
  ctx: OntoCodeStoreContext,
  stepId: string,
  observation: Record<string, unknown>,
): OntoCodeAssistantStep {
  const now = new Date();
  const outputJson = canonicalEvidenceJson(observation);
  const updated = getDb()
    .update(ontocodeAssistantSteps)
    .set({
      status: "succeeded",
      outputHash: sha256(outputJson),
      observationJson: outputJson,
      errorCode: null,
      errorMessage: null,
      finishedAt: now,
      updatedAt: now,
    })
    .where(
      tenantScope(
        ctx,
        ontocodeAssistantSteps,
      )(
        and(
          eq(ontocodeAssistantSteps.id, stepId),
          eq(ontocodeAssistantSteps.status, "running"),
        ),
      ),
    )
    .returning()
    .get();
  if (!updated) {
    const existing = getDb()
      .select()
      .from(ontocodeAssistantSteps)
      .where(
        tenantScope(
          ctx,
          ontocodeAssistantSteps,
        )(eq(ontocodeAssistantSteps.id, stepId)),
      )
      .get();
    if (
      existing?.status === "succeeded" &&
      existing.outputHash === sha256(outputJson)
    ) {
      return stepFromRow(existing);
    }
    throw new OntoCodeStoreError(
      "ontocode_assistant_step_not_running",
      "OntoCode Assistant Step is not running",
      409,
    );
  }
  return stepFromRow(updated);
}

export function persistOntoCodeCompiledContext(
  ctx: OntoCodeStoreContext,
  runId: string,
  compiled: OntoCodeCompiledContext,
): OntoCodeAssistantRun {
  return getDb().transaction((tx) => {
    const runRow = tx
      .select()
      .from(ontocodeAssistantRuns)
      .where(
        tenantScope(
          ctx,
          ontocodeAssistantRuns,
        )(eq(ontocodeAssistantRuns.id, runId)),
      )
      .get();
    if (!runRow) {
      throw new OntoCodeStoreError(
        "ontocode_assistant_run_not_found",
        "OntoCode Assistant Run not found",
        404,
      );
    }
    if (runRow.sessionId !== compiled.sessionId) {
      throw new OntoCodeStoreError(
        "ontocode_context_ref_session_mismatch",
        "Compiled context belongs to a different OntoCode Session",
        409,
      );
    }
    if (runRow.contextHash && runRow.contextHash !== compiled.contextHash) {
      throw new OntoCodeStoreError(
        "ontocode_assistant_context_conflict",
        "This Assistant Run already pinned a different context",
        409,
      );
    }
    const now = new Date();
    for (const [ordinal, ref] of compiled.refs.entries()) {
      const existing = tx
        .select()
        .from(ontocodePinnedContextRefs)
        .where(
          tenantScope(
            ctx,
            ontocodePinnedContextRefs,
          )(
            and(
              eq(ontocodePinnedContextRefs.assistantRunId, runId),
              eq(ontocodePinnedContextRefs.ordinal, ordinal),
            ),
          ),
        )
        .get();
      if (existing) {
        if (
          existing.canonicalRef !== ref.canonicalRef ||
          existing.contentHash !== ref.contentHash
        ) {
          throw new OntoCodeStoreError(
            "ontocode_assistant_context_conflict",
            "This Assistant Run already pinned a different context reference",
            409,
          );
        }
        continue;
      }
      tx.insert(ontocodePinnedContextRefs)
        .values({
          id: makeId("occr"),
          tenantId: ctx.tenantId,
          sessionId: runRow.sessionId,
          assistantRunId: runId,
          ordinal,
          kind: ref.kind,
          requestedRef: ref.requestedRef,
          canonicalRef: ref.canonicalRef,
          artifactId: ref.artifactId,
          artifactVersionId: ref.artifactVersionId,
          evidenceId: ref.evidenceId,
          changeSetId: ref.changeSetId,
          contentHash: ref.contentHash,
          // #CONTEXT-HONESTY —— 这是这条引用唯一的持久凭据。以前只记 truncated
          // 布尔值，事后复盘一个「模型好像没看到后面内容」的问题时，根本查不出它
          // 当时到底拿到了整篇的百分之几。真实的截断前计数必须一起落盘。
          metadataJson: canonicalEvidenceJson({
            ...ref.metadata,
            truncated: ref.truncated,
            redacted: ref.redacted,
            rawBytes: ref.rawBytes,
            includedBytes: ref.includedBytes,
            droppedBytes: ref.droppedBytes,
            truncationReason: ref.truncationReason,
          }),
          createdAt: now,
        })
        .run();
    }
    const updated = tx
      .update(ontocodeAssistantRuns)
      .set({
        contextHash: compiled.contextHash,
        contextManifestJson: canonicalEvidenceJson(compiled.manifest),
        updatedAt: now,
      })
      .where(
        tenantScope(
          ctx,
          ontocodeAssistantRuns,
        )(eq(ontocodeAssistantRuns.id, runId)),
      )
      .returning()
      .get();
    if (!updated) {
      throw new OntoCodeStoreError(
        "ontocode_assistant_run_not_found",
        "OntoCode Assistant Run not found",
        404,
      );
    }
    return runFromRow(updated);
  });
}

export function completeOntoCodeAssistantRun(
  ctx: OntoCodeStoreContext,
  runId: string,
  input: {
    model: string | null;
    terminalResponse: Record<string, unknown>;
  },
): OntoCodeAssistantRun {
  return getDb().transaction((tx) => {
    const runRow = tx
      .select()
      .from(ontocodeAssistantRuns)
      .where(
        tenantScope(
          ctx,
          ontocodeAssistantRuns,
        )(eq(ontocodeAssistantRuns.id, runId)),
      )
      .get();
    if (!runRow) {
      throw new OntoCodeStoreError(
        "ontocode_assistant_run_not_found",
        "OntoCode Assistant Run not found",
        404,
      );
    }
    const terminalJson = canonicalEvidenceJson(input.terminalResponse);
    if (runRow.status === "succeeded") {
      if (runRow.terminalResponseJson !== terminalJson) {
        throw new OntoCodeStoreError(
          "ontocode_assistant_run_conflict",
          "The Assistant Run already completed with a different response",
          409,
        );
      }
      return runFromRow(runRow);
    }
    if (runRow.status === "failed" || runRow.status === "cancelled") {
      throw new OntoCodeStoreError(
        "ontocode_assistant_run_terminal",
        "A failed or cancelled Assistant Run cannot be completed",
        409,
      );
    }
    const session = tx
      .select()
      .from(ontocodeSessions)
      .where(
        tenantScope(
          ctx,
          ontocodeSessions,
        )(eq(ontocodeSessions.id, runRow.sessionId)),
      )
      .get();
    if (!session) {
      throw new OntoCodeStoreError(
        "ontocode_session_not_found",
        "OntoCode build session not found",
        404,
      );
    }
    const now = new Date();
    const updated = tx
      .update(ontocodeAssistantRuns)
      .set({
        status: "succeeded",
        model: input.model,
        terminalResponseJson: terminalJson,
        errorCode: null,
        errorMessage: null,
        finishedAt: now,
        updatedAt: now,
      })
      .where(
        tenantScope(
          ctx,
          ontocodeAssistantRuns,
        )(eq(ontocodeAssistantRuns.id, runId)),
      )
      .returning()
      .get();
    appendAssistantEvent(tx, {
      tenantId: ctx.tenantId,
      projectId: session.projectId,
      sessionId: runRow.sessionId,
      type: "assistant.run.succeeded",
      payload: {
        assistantRunId: runId,
        sourceMessageId: runRow.sourceMessageId,
        contextHash: runRow.contextHash,
        model: input.model,
      },
      correlationId: `ocar-${runId}`,
      causationId: runId,
      now,
      // Pairs with assistant.run.accepted — a lane needs both ends to have a
      // state at all.
      visibility: "debug",
    });
    return runFromRow(updated!);
  });
}

function errorCode(error: unknown): string {
  if (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return error.code.slice(0, 200);
  }
  return "ontocode_assistant_run_failed";
}

/**
 * A schema validator's own `.message` is a JSON dump of its issue list. This
 * function's output is written into an `error` CHAT MESSAGE below, so passing
 * such a message through verbatim puts machine output on the FDE's screen —
 * which is exactly what happened live: a raw
 * `[{"code":"too_big","path":["messages",2,"text"], ...}]` was persisted as
 * message text and shown in the conversation.
 *
 * The producing defect is fixed at its source (the planner now raises a typed,
 * plain-language error for an unassemblable request). This is the BACKSTOP for
 * every other validator inside the same try block, so the class of failure
 * cannot come back through a different door.
 *
 * Detection is structural rather than `instanceof ZodError` on purpose: it also
 * catches an issue list that was re-thrown or serialised on the way here.
 */
function looksLikeValidatorIssueDump(message: string): boolean {
  const trimmed = message.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return false;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return (
      Array.isArray(parsed) &&
      parsed.length > 0 &&
      parsed.every(
        (issue) =>
          issue !== null &&
          typeof issue === "object" &&
          "code" in (issue as Record<string, unknown>) &&
          "path" in (issue as Record<string, unknown>),
      )
    );
  } catch {
    // Not JSON at all — ordinary prose that merely contains brackets.
    return false;
  }
}

/**
 * The sentence an FDE is allowed to read for a failed Assistant Run. Named and
 * exported so the rule is testable at the place that enforces it.
 */
export function ontoCodeAssistantRunErrorSentence(error: unknown): string {
  const raw = (
    (error instanceof Error ? error.message : String(error)) ||
    "OntoCode Assistant Run failed"
  )
    .normalize("NFKC")
    .trim();
  if (looksLikeValidatorIssueDump(raw)) {
    // Says what is true and whose fault it is, without blaming the model for
    // a server-side validation failure. The dump itself still reaches the
    // server log and the step's structured evidence.
    return "这一轮没能完成：服务端内部的数据校验没有通过，所以没有执行任何操作。这是本产品自身的缺陷，不是你的输入有问题。详细信息已记录在本次回执里。";
  }
  return raw.slice(0, 8_000);
}

function errorMessage(error: unknown): string {
  return ontoCodeAssistantRunErrorSentence(error);
}

/**
 * The structured reason an error carried, if any. A refusal that keeps no
 * evidence leaves the receipt unable to answer "why" — which is how a live
 * `ontocode_assistant_planner_invalid_response` came to persist an empty
 * observation while both provider calls had in fact succeeded.
 *
 * Only a JSON-serialisable object is taken, and only from the error's own
 * `details`; nothing is inferred about the cause.
 */
function errorEvidence(error: unknown): Record<string, unknown> | null {
  if (error === null || typeof error !== "object" || !("details" in error)) {
    return null;
  }
  const details = (error as { details?: unknown }).details;
  if (details === null || typeof details !== "object" || Array.isArray(details)) {
    return null;
  }
  try {
    const encoded = JSON.stringify(details);
    if (!encoded || encoded.length > 32_000) return null;
    return JSON.parse(encoded) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function failOntoCodeAssistantRun(
  ctx: OntoCodeStoreContext,
  runId: string,
  error: unknown,
  activeStepId?: string,
): OntoCodeAssistantRun {
  return getDb().transaction((tx) => {
    const runRow = tx
      .select()
      .from(ontocodeAssistantRuns)
      .where(
        tenantScope(
          ctx,
          ontocodeAssistantRuns,
        )(eq(ontocodeAssistantRuns.id, runId)),
      )
      .get();
    if (!runRow) {
      throw new OntoCodeStoreError(
        "ontocode_assistant_run_not_found",
        "OntoCode Assistant Run not found",
        404,
      );
    }
    if (runRow.status === "succeeded" || runRow.status === "cancelled") {
      return runFromRow(runRow);
    }
    const session = tx
      .select()
      .from(ontocodeSessions)
      .where(
        tenantScope(
          ctx,
          ontocodeSessions,
        )(eq(ontocodeSessions.id, runRow.sessionId)),
      )
      .get();
    if (!session) {
      throw new OntoCodeStoreError(
        "ontocode_session_not_found",
        "OntoCode build session not found",
        404,
      );
    }
    const now = new Date();
    const code = errorCode(error);
    const message = errorMessage(error);
    const evidence = errorEvidence(error);
    if (activeStepId) {
      tx.update(ontocodeAssistantSteps)
        .set({
          status: "failed",
          errorCode: code,
          errorMessage: message,
          finishedAt: now,
          updatedAt: now,
          // Keep whatever the failure could prove. Absent evidence stays absent
          // rather than becoming an empty object that reads like "nothing was
          // wrong" — see the empty-observation live case.
          ...(evidence ? { observationJson: JSON.stringify(evidence) } : {}),
        })
        .where(
          tenantScope(
            ctx,
            ontocodeAssistantSteps,
          )(
            and(
              eq(ontocodeAssistantSteps.id, activeStepId),
              eq(ontocodeAssistantSteps.assistantRunId, runId),
              eq(ontocodeAssistantSteps.status, "running"),
            ),
          ),
        )
        .run();
    }
    const updated = tx
      .update(ontocodeAssistantRuns)
      .set({
        status: "failed",
        errorCode: code,
        errorMessage: message,
        finishedAt: now,
        updatedAt: now,
      })
      .where(
        tenantScope(
          ctx,
          ontocodeAssistantRuns,
        )(eq(ontocodeAssistantRuns.id, runId)),
      )
      .returning()
      .get();
    if (session.activityState === "ai_planning") {
      tx.update(ontocodeSessions)
        .set({
          activityState: "failed_recoverable",
          revision: session.revision + 1,
          updatedAt: now,
        })
        .where(
          tenantScope(
            ctx,
            ontocodeSessions,
          )(
            and(
              eq(ontocodeSessions.id, runRow.sessionId),
              eq(ontocodeSessions.revision, session.revision),
            ),
          ),
        )
        .run();
    }

    const errorIdempotencyKey = `assistant-run-error:${runId}`;
    const existingErrorMessage = tx
      .select({ id: ontocodeSessionMessages.id })
      .from(ontocodeSessionMessages)
      .where(
        tenantScope(
          ctx,
          ontocodeSessionMessages,
        )(
          and(
            eq(ontocodeSessionMessages.sessionId, runRow.sessionId),
            eq(ontocodeSessionMessages.idempotencyKey, errorIdempotencyKey),
          ),
        ),
      )
      .get();
    if (!existingErrorMessage) {
      tx.insert(ontocodeSessionMessages)
        .values({
          id: makeId("ocm"),
          tenantId: ctx.tenantId,
          sessionId: runRow.sessionId,
          role: "assistant",
          type: "error",
          contentJson: canonicalEvidenceJson({
            text: message,
            assistantRunId: runId,
            errorCode: code,
            retryable: true,
          }),
          idempotencyKey: errorIdempotencyKey,
          commandId: null,
          correlationId: `ocar-${runId}`,
          createdAt: now,
        })
        .run();
    }
    appendAssistantEvent(tx, {
      tenantId: ctx.tenantId,
      projectId: session.projectId,
      sessionId: runRow.sessionId,
      type: "assistant.run.failed",
      payload: {
        assistantRunId: runId,
        sourceMessageId: runRow.sourceMessageId,
        errorCode: code,
        errorMessage: message,
        retryable: true,
      },
      correlationId: `ocar-${runId}`,
      causationId: runId,
      now,
      visibility: "user",
    });
    return runFromRow(updated!);
  });
}

export function getOntoCodeAssistantRun(
  ctx: Pick<OntoCodeStoreContext, "tenantId">,
  runId: string,
): {
  run: OntoCodeAssistantRun;
  steps: OntoCodeAssistantStep[];
  contextRefs: OntoCodePinnedContextRef[];
} {
  const runRow = getDb()
    .select()
    .from(ontocodeAssistantRuns)
    .where(
      tenantScope(
        ctx,
        ontocodeAssistantRuns,
      )(eq(ontocodeAssistantRuns.id, runId)),
    )
    .get();
  if (!runRow) {
    throw new OntoCodeStoreError(
      "ontocode_assistant_run_not_found",
      "OntoCode Assistant Run not found",
      404,
    );
  }
  return {
    run: runFromRow(runRow),
    steps: getDb()
      .select()
      .from(ontocodeAssistantSteps)
      .where(
        tenantScope(
          ctx,
          ontocodeAssistantSteps,
        )(eq(ontocodeAssistantSteps.assistantRunId, runId)),
      )
      .orderBy(asc(ontocodeAssistantSteps.ordinal))
      .all()
      .map(stepFromRow),
    contextRefs: getDb()
      .select()
      .from(ontocodePinnedContextRefs)
      .where(
        tenantScope(
          ctx,
          ontocodePinnedContextRefs,
        )(eq(ontocodePinnedContextRefs.assistantRunId, runId)),
      )
      .orderBy(asc(ontocodePinnedContextRefs.ordinal))
      .all()
      .map(pinnedRefFromRow),
  };
}

export function listOntoCodeAssistantRuns(
  ctx: Pick<OntoCodeStoreContext, "tenantId">,
  sessionId: string,
  input: {
    limit: number;
    offset: number;
    status?: OntoCodeAssistantRun["status"];
  },
): Page<OntoCodeAssistantRun> {
  getOntoCodeSession(ctx, sessionId);
  const conditions = [eq(ontocodeAssistantRuns.sessionId, sessionId)];
  if (input.status) {
    conditions.push(eq(ontocodeAssistantRuns.status, input.status));
  }
  const rows = getDb()
    .select()
    .from(ontocodeAssistantRuns)
    .where(tenantScope(ctx, ontocodeAssistantRuns)(and(...conditions)))
    .orderBy(
      desc(ontocodeAssistantRuns.createdAt),
      desc(ontocodeAssistantRuns.id),
    )
    .limit(input.limit + 1)
    .offset(input.offset)
    .all()
    .map(runFromRow);
  const hasNext = rows.length > input.limit;
  const items = hasNext ? rows.slice(0, input.limit) : rows;
  return {
    items,
    count: items.length,
    nextOffset: hasNext ? input.offset + input.limit : null,
  };
}

export function assistantTerminalResponse(
  run: OntoCodeAssistantRun,
): Record<string, unknown> | null {
  return run.status === "succeeded" ? run.terminalResponse : null;
}

export function acceptedAssistantSession(
  ctx: Pick<OntoCodeStoreContext, "tenantId">,
  acceptance: OntoCodeAssistantRunAcceptance,
): OntoCodeBuildSession {
  return getOntoCodeSession(ctx, acceptance.run.sessionId);
}

/**
 * Recent succeeded Step observations of one kind for a Session, newest first.
 *
 * The in-band configuration flow persists its secret-free proposal as a
 * `result_review` observation and re-reads it here when the FDE sends the
 * server-minted confirmation back. Keeping the lookup in this store means the
 * read stays tenant-scoped and bounded instead of scanning Assistant Runs
 * one-by-one through the public API.
 */
export function listRecentOntoCodeAssistantStepObservations(
  ctx: Pick<OntoCodeStoreContext, "tenantId">,
  sessionId: string,
  input: { kind: OntoCodeAssistantStep["kind"]; limit: number },
): Array<Record<string, unknown>> {
  const limit = Math.max(1, Math.min(50, Math.trunc(input.limit)));
  return getDb()
    .select({ observationJson: ontocodeAssistantSteps.observationJson })
    .from(ontocodeAssistantSteps)
    .where(
      tenantScope(
        ctx,
        ontocodeAssistantSteps,
      )(
        and(
          eq(ontocodeAssistantSteps.sessionId, sessionId),
          eq(ontocodeAssistantSteps.kind, input.kind),
          eq(ontocodeAssistantSteps.status, "succeeded"),
        ),
      ),
    )
    .orderBy(desc(ontocodeAssistantSteps.createdAt))
    .limit(limit)
    .all()
    .flatMap((row) => {
      try {
        const parsed = JSON.parse(row.observationJson) as unknown;
        return parsed && typeof parsed === "object" && !Array.isArray(parsed)
          ? [parsed as Record<string, unknown>]
          : [];
      } catch {
        return [];
      }
    });
}
