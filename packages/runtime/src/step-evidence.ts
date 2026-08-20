/**
 * #RUN-EVIDENCE — required-evidence failure semantics, shared by the durable
 * step loop (register.ts) and the nested foreach engine (step-engine.ts).
 *
 * Evidence writes are not best-effort: a step whose input/output/tool-call
 * record cannot be persisted must FAIL, because a run that completed without
 * its evidence is indistinguishable from a run that fabricated its result.
 * The class lives in its own module (rather than register.ts, where it was
 * born) so step-engine's nested-action failure classifier can recognize it
 * WITHOUT importing register.ts (which imports step-engine — a cycle) and
 * without matching on an error-name string. An evidence failure must never be
 * softened by a manifest `on_error` policy at any nesting depth.
 */
export class RequiredStepEvidenceError extends Error {
  override readonly cause: unknown;

  constructor(label: string, cause: unknown) {
    super(
      `required step evidence '${label}' failed: ${String(
        (cause as { message?: unknown } | null)?.message ?? cause,
      )}`,
    );
    this.name = "RequiredStepEvidenceError";
    this.cause = cause;
  }
}

/**
 * Recognize an evidence failure ACROSS the Inngest SDK boundary.
 *
 * The four carve-outs that refuse to soften evidence failures used to be
 * `instanceof` checks — correct in-process, wrong after a retry/memoization
 * round-trip: inngest's StepError reconstruction copies only the original
 * error's `name`, so class identity is lost and a replayed evidence failure
 * would fall through to the manifest `on_error` classifier. Mirrors
 * `isNonRetriableFailure` (error-policy.ts): bounded walk of the value plus
 * its cause/error/reason chains; a match is instanceof OR a real Error whose
 * `name` is exactly "RequiredStepEvidenceError". A plain object claiming the
 * name is NOT a match — payload data must not be able to impersonate a
 * runtime evidence failure.
 */
export function isRequiredStepEvidenceFailure(value: unknown): boolean {
  const queue: unknown[] = [value];
  const seen = new Set<unknown>();
  for (let i = 0; i < queue.length && i < 12; i++) {
    const current = queue[i];
    if (current == null || seen.has(current)) continue;
    seen.add(current);
    if (current instanceof RequiredStepEvidenceError) return true;
    if (
      current instanceof Error &&
      current.name === "RequiredStepEvidenceError"
    ) {
      return true;
    }
    const rec = asRecord(current);
    if (rec) queue.push(rec.cause, rec.error, rec.reason);
  }
  return false;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Run one evidence-persisting operation, converting any failure into the
 * non-softenable RequiredStepEvidenceError with a human-readable label. */
export async function requireStepEvidence<T>(
  label: string,
  operation: () => T | Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw new RequiredStepEvidenceError(label, error);
  }
}
