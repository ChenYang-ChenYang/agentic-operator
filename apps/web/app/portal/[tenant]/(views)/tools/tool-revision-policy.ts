import type {
  ManagedToolRevision,
  ToolLifecycleBlocker,
} from "@/lib/hooks/useTools";

export interface ToolRevisionReviewPolicy {
  writeLike: boolean;
  lifecycleCandidate: boolean;
  canProbe: boolean;
  canActivateAfterExactProbe: boolean;
  canReject: boolean;
  blocker?: ToolLifecycleBlocker;
}

/** Deterministic presentation policy for the managed revision lifecycle.
 * UI affordances are derived only from reviewed revision facts, never a tool
 * name or HTTP verb. Server-side checks remain authoritative. */
export function deriveToolRevisionReviewPolicy(
  revision: ManagedToolRevision,
): ToolRevisionReviewPolicy {
  const sideEffect = revision.definition.sideEffect;
  const operation = revision.definition.operation;
  const writeLike =
    sideEffect === "write" ||
    sideEffect === "dual" ||
    operation === "write" ||
    operation === "read_write";
  const lifecycleCandidate =
    revision.status === "draft" || revision.status === "retired";
  const eligible =
    revision.validation.passed &&
    revision.activation.eligible === true &&
    !writeLike;
  return {
    writeLike,
    lifecycleCandidate,
    canProbe: lifecycleCandidate && eligible,
    canActivateAfterExactProbe: lifecycleCandidate && eligible,
    canReject: revision.status === "draft",
    ...(revision.activation.blockers[0]
      ? { blocker: revision.activation.blockers[0] }
      : {}),
  };
}
