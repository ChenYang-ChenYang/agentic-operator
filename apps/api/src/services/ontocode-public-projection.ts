import type {
  OntoCodeHarnessJob,
  OntoCodeMessage,
  OntoCodeSessionEvent,
} from "@agentic/contracts";

/**
 * #ONTOCODE-PUBLIC-BOUNDARY
 *
 * Agent Factory is an implementation kernel. Its recovery invariants are
 * useful to the worker and to immutable audit evidence, but they are not part
 * of the OntoCode Session contract. In particular, an FDE must never have to
 * understand a Factory-start/clarification checkpoint or match one to a
 * worker attempt in order to recover an OntoCode Build.
 *
 * Keep the persisted rows byte-for-byte truthful and project them only when a
 * public Session read leaves the API. This also repairs historical Sessions
 * without rewriting their audit trail.
 */

export const ONTOCODE_BUILD_RESUME_STATE_UNAVAILABLE =
  "ontocode_build_resume_state_unavailable";

export const ONTOCODE_BUILD_RESUME_STATE_UNAVAILABLE_MESSAGE =
  "OntoCode 无法从已记录的等待状态继续本次代码生成；本次执行记录已保留。";

const PRIVATE_WAITING_CODES = new Set([
  "factory_waiting_checkpoint_ambiguous",
  "factory_waiting_checkpoint_attempt_mismatch",
  "factory_waiting_checkpoint",
  // Historical render-boundary aliases. They were product-renamed, but still
  // exposed the private checkpoint/attempt contract.
  "ontocode_engine_waiting_checkpoint_ambiguous",
  "ontocode_engine_waiting_checkpoint_attempt_mismatch",
  "ontocode_engine_waiting_checkpoint",
]);

const PRIVATE_WAITING_TEXT: readonly RegExp[] = [
  /Agent Factory 停在 (?=(?:factory|ontocode_engine)_waiting_checkpoint)/giu,
  /The retry does not have one unfinalized Factory-start\/clarification checkpoint/giu,
  /The retry does not have one unfinalized internal(?: generation engine)?-start\/clarification checkpoint/giu,
  /The (?:Factory|internal generation engine|internal) waiting checkpoint is not bounded by one exact worker-stopped retry attempt/giu,
  /The historical final-turn gate is not bounded by one exact failed-Build\/operator-retry chain/giu,
];

function resetAndTest(pattern: RegExp, value: string): boolean {
  pattern.lastIndex = 0;
  return pattern.test(value);
}

function isPrivateWaitingCode(value: unknown): value is string {
  return typeof value === "string" && PRIVATE_WAITING_CODES.has(value);
}

function containsPrivateWaitingText(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if ([...PRIVATE_WAITING_CODES].some((code) => value.includes(code))) {
    return true;
  }
  return PRIVATE_WAITING_TEXT.some((pattern) => resetAndTest(pattern, value));
}

/**
 * Project a human-facing error line while retaining any surrounding, useful
 * OntoCode evidence summary. Only the private invariant is replaced.
 */
export function publicOntoCodeFailureText(value: string): string {
  let projected = value.replace(
    /\bHarness 无法完成 build\b/giu,
    "OntoCode 无法完成代码生成",
  );
  for (const pattern of PRIVATE_WAITING_TEXT) {
    pattern.lastIndex = 0;
    projected = projected.replace(
      pattern,
      ONTOCODE_BUILD_RESUME_STATE_UNAVAILABLE_MESSAGE,
    );
  }
  for (const code of PRIVATE_WAITING_CODES) {
    projected = projected.replaceAll(
      code,
      ONTOCODE_BUILD_RESUME_STATE_UNAVAILABLE,
    );
  }
  // Generic private-kernel vocabulary has no place in an OntoCode-facing
  // sentence either. Apply this after the specific recovery mappings so a
  // real OntoCode-owned error code wins over a cosmetic prefix rewrite.
  return projected
    .replace(
      /(?:Agent Factory|OntoCode 内部生成引擎) ended with/giu,
      "OntoCode 代码生成未完成：",
    )
    .replace(/OntoCode 内部生成引擎/giu, "OntoCode 代码生成")
    .replace(/\ba Factory\b/giu, "an OntoCode")
    .replace(/\bAgent Factory\b/giu, "OntoCode")
    .replace(/\bFactory\b/giu, "OntoCode")
    .replace(/\b(?:factory|ontocode_engine)_/giu, "ontocode_");
}

function publicFailureObject(
  value: Record<string, unknown>,
): Record<string, unknown> {
  const projected: Record<string, unknown> = {
    code: ONTOCODE_BUILD_RESUME_STATE_UNAVAILABLE,
    message: ONTOCODE_BUILD_RESUME_STATE_UNAVAILABLE_MESSAGE,
  };
  // These are OntoCode policy facts, not engine ancestry. Preserve them so a
  // client can still decide whether to offer a safe recovery action.
  if (typeof value.recoverable === "boolean") {
    projected.recoverable = value.recoverable;
  }
  if (typeof value.retryable === "boolean") {
    projected.retryable = value.retryable;
  }
  return projected;
}

/** Deep projection for structured error envelopes in events and messages. */
export function projectOntoCodePublicValue(value: unknown): unknown {
  if (typeof value === "string") return publicOntoCodeFailureText(value);
  if (Array.isArray(value)) return value.map(projectOntoCodePublicValue);
  if (!value || typeof value !== "object") return value;

  const record = value as Record<string, unknown>;
  if (
    isPrivateWaitingCode(record.code) ||
    containsPrivateWaitingText(record.message)
  ) {
    // Deliberately discard checkpoint counts, attempt ancestry, run ids and
    // other private `details`: none are actionable through the OntoCode API.
    return publicFailureObject(record);
  }

  return Object.fromEntries(
    Object.entries(record).map(([key, child]) => [
      key,
      projectOntoCodePublicValue(child),
    ]),
  );
}

export function publicOntoCodeHarnessJob(
  job: OntoCodeHarnessJob,
): OntoCodeHarnessJob {
  return {
    ...job,
    errorMessage:
      job.errorMessage === null
        ? null
        : publicOntoCodeFailureText(job.errorMessage),
  };
}

export function publicOntoCodeMessage(
  message: OntoCodeMessage,
): OntoCodeMessage {
  // A human may quote an internal code while reporting a bug. Their authored
  // text is evidence and must not be silently rewritten.
  if (message.role === "user") return message;
  return {
    ...message,
    content: projectOntoCodePublicValue(
      message.content,
    ) as OntoCodeMessage["content"],
  };
}

export function publicOntoCodeSessionEvent(
  event: OntoCodeSessionEvent,
): OntoCodeSessionEvent {
  return {
    ...event,
    payload: projectOntoCodePublicValue(
      event.payload,
    ) as OntoCodeSessionEvent["payload"],
  };
}
