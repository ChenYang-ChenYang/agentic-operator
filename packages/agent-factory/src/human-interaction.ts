import { createHash, randomUUID } from "node:crypto";
import type { FactoryHumanInteractionKind, FactoryPendingHumanInteraction } from "./authorization-challenge";
import type { BrainCtx, BrainEvent } from "./brain-types";

type GateState = Pick<
  BrainCtx,
  | "awaitingClarify"
  | "awaitingApproval"
  | "testDataSupplementPending"
  | "awaitingBoundary"
  | "humanInteractions"
>;

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, nested]) => `${JSON.stringify(key)}:${stable(nested)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function digest(value: unknown): string {
  return createHash("sha256").update(stable(value), "utf8").digest("hex");
}

function gateEvent(event: BrainEvent): {
  kind: FactoryHumanInteractionKind;
  pending: boolean;
  subject: unknown;
} | null {
  if (event.t === "clarify") {
    return {
      kind: "clarify",
      pending: event.awaitingAnswer,
      subject: {
        question: event.question,
        context: event.context ?? null,
        options: event.options ?? null,
      },
    };
  }
  if (event.t === "test.cases") {
    return {
      kind: "test_approval",
      pending: event.awaitingApproval,
      subject: { cases: event.cases, coverage: event.coverage ?? null },
    };
  }
  if (event.t === "boundary.cases") {
    return {
      kind: "boundary",
      pending: event.awaitingDecision,
      subject: event.proposals,
    };
  }
  return null;
}

/** Open (or idempotently re-emit) a gate. A changed subject always rotates the
 * id, so an answer to an older version of the same gate cannot hit the new one. */
export function openHumanInteraction(
  ctx: BrainCtx,
  kind: FactoryHumanInteractionKind,
  subject: unknown,
): FactoryPendingHumanInteraction {
  const subjectDigest = digest(subject);
  const current = ctx.humanInteractions?.[kind];
  if (current?.subjectDigest === subjectDigest) return current;
  const next: FactoryPendingHumanInteraction = {
    interactionId: `hitl_${randomUUID()}`,
    kind,
    subjectDigest,
    createdAt: Date.now(),
  };
  (ctx.humanInteractions ??= {})[kind] = next;
  return next;
}

export function closeHumanInteraction(
  ctx: BrainCtx,
  kind: FactoryHumanInteractionKind,
): FactoryPendingHumanInteraction | undefined {
  const current = ctx.humanInteractions?.[kind];
  if (ctx.humanInteractions) delete ctx.humanInteractions[kind];
  return current;
}

/** Adds the exact id to every actionable frame. This is called by the
 * conductor's ctx.emit boundary, so tools cannot accidentally create an
 * unaddressable human gate. */
export function bindHumanInteractionEvent(ctx: BrainCtx, event: BrainEvent): BrainEvent {
  const gate = gateEvent(event);
  if (!gate) return event;
  const interaction = gate.pending
    ? openHumanInteraction(ctx, gate.kind, gate.subject)
    : ctx.humanInteractions?.[gate.kind];
  return interaction
    ? ({ ...event, interactionId: interaction.interactionId } as unknown as BrainEvent)
    : event;
}

/** Single authoritative priority shared by API, conductor and Web. */
export function activeHumanInteractionKind(state: GateState): FactoryHumanInteractionKind | null {
  return state.awaitingClarify
    ? "clarify"
    : state.awaitingApproval && !state.testDataSupplementPending
      ? "test_approval"
      : state.awaitingBoundary
        ? "boundary"
        : null;
}

export function activeHumanInteraction(state: GateState): FactoryPendingHumanInteraction | null {
  const kind = activeHumanInteractionKind(state);
  if (!kind) return null;
  const interaction = state.humanInteractions?.[kind];
  return interaction?.kind === kind ? interaction : null;
}

/** Verify that a persisted interaction identity still belongs to the exact
 * prompt/cases/boundary subject that opened it. Durable recovery must not rely
 * on the gate kind alone: a stale `clarifyPrompt` paired with a newer clarify
 * interaction is not an addressable human checkpoint. */
export function humanInteractionMatchesSubject(
  interaction: FactoryPendingHumanInteraction,
  kind: FactoryHumanInteractionKind,
  subject: unknown,
): boolean {
  return (
    interaction.kind === kind && interaction.subjectDigest === digest(subject)
  );
}
