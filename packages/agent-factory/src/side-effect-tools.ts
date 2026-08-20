// #SIDE-EFFECT-CKPT (WS1) + #TOOL-EFFECT (P0-2) — the brain-tool effect registry.
//
// WS1 answered "which brain tools produce a durable/external/billed effect that MUST NOT be
// re-issued on crash-resume?" with a hand-authored Set of 16 names. That set was a parallel source
// of truth for information that belongs ON each tool, and it failed OPEN: a genuinely new
// side-effecting tool was silently classified as harmless until somebody remembered to edit it.
//
// P0-2 inverts that. `BrainTool.effect` is a REQUIRED field (packages/agent-factory/src/brain-types.ts),
// so an unannotated tool is a compile error; this module only INDEXES what the tools declare and
// derives both consumers from it:
//   • isSideEffectTool(name)      → the crash-resume checkpoint boundary (conductor #SIDE-EFFECT-CKPT).
//   • brainToolEffect(name)       → the #W2-STAGE admission gate + the later risk-tier table.
//
// WHY the checkpoint promotion matters: the conductor checkpoints the conversation ONCE at the end
// of every turn (#CRASH-CKPT, conductor.ts). That is enough for read-only or in-memory work, but a
// tool whose whole point is an irreversible effect (deploying an ephemeral sandbox + running real
// billed tests, persisting a draft/tool/skill/report) leaves its `role:"tool"` result only in the
// in-memory `messages` array until the turn ends. If the process dies AFTER the effect but BEFORE
// that end-of-turn save, boot auto-resume replays from the previous checkpoint and re-issues the
// call — re-deploying a second sandbox, re-billing test runs, appending a duplicate draft version.
// `checkpoint: "immediate"` promotes the durable snapshot to "right after the tool returns". An
// extra SQLite upsert is cheap; a duplicated side effect is not. Defense-in-depth only — WS2/WS3
// also make the two most expensive effects (sandbox_run, save_draft) idempotent on replay.

import type { BrainTool, BrainToolEffect, FactoryStage } from "./brain-types";

/** name → declared effect, populated by registerBrainToolEffects at module-eval (boot) time. */
const DECLARED = new Map<string, BrainToolEffect>();

/** Thrown at registration when a declaration is internally inconsistent. Boot-time by design: a
 *  misdeclared tool is a programming error, and shipping it would re-open the fail-open hole. */
export class BrainToolEffectDeclarationError extends Error {}

/**
 * Index every brain tool the harness can dispatch. Called at conductor module scope with the ACTUAL
 * root + sub-agent surfaces, so "registered" means "reachable by a brain", not "listed somewhere".
 *
 * Re-registering the same name with an equivalent declaration is a no-op (module re-evaluation under
 * vitest `resetModules` is normal); re-registering it with a DIFFERENT declaration is an error,
 * because then two tools would answer to one name with two blast radii.
 */
export function registerBrainToolEffects(
  ...groups: ReadonlyArray<readonly BrainTool[]>
): void {
  for (const group of groups) {
    for (const tool of group) {
      const prior = DECLARED.get(tool.name);
      if (prior && !sameEffect(prior, tool.effect))
        throw new BrainToolEffectDeclarationError(
          `brain tool "${tool.name}" is registered twice with different effect declarations ` +
            `(${describeEffect(prior)} vs ${describeEffect(tool.effect)}); one name must mean one blast radius.`,
        );
      DECLARED.set(tool.name, tool.effect);
    }
  }
}

/**
 * #W2-STAGE boot assertion — every registered tool is either stage-registered (a real `gate`) or
 * EXPLICITLY declared stage-free with a written reason. Fails closed by throwing and naming the
 * offending tool, so a future tool cannot silently re-open the "absent from the table ⇒ waved
 * through" hole.
 *
 * A tool whose effect never leaves the conversation (`scope` "none"/"conversation") may declare
 * `gate:"any"` with no reason: there is nothing to gate. Anything that persists, deploys, bills or
 * reaches a third party must say why it sits outside the pipeline order.
 */
export function assertBrainToolGatesDeclared(
  ...groups: ReadonlyArray<readonly BrainTool[]>
): void {
  for (const group of groups) {
    for (const tool of group) {
      const { gate, scope, advancesStage, stageFreeReason } = tool.effect;
      if (gate === "any") {
        if (
          scope !== "none" &&
          scope !== "conversation" &&
          !stageFreeReason?.trim()
        )
          throw new BrainToolEffectDeclarationError(
            `brain tool "${tool.name}" declares gate:"any" with scope:"${scope}" but no stageFreeReason — ` +
              `a stage-free side effect must be a reviewed decision: register it to its real stage, or ` +
              `state what gates the effect instead.`,
          );
        if (advancesStage)
          throw new BrainToolEffectDeclarationError(
            `brain tool "${tool.name}" declares advancesStage with gate:"any" — the canvas rail cannot ` +
              `move to a stage the tool does not claim.`,
          );
      }
    }
  }
}

/** The declared effect of a canonical brain tool, or undefined when the name is unknown to the
 *  harness. Callers MUST treat undefined as "unknown blast radius" and fail closed. */
export function brainToolEffect(toolName: string): BrainToolEffect | undefined {
  return DECLARED.get(toolName);
}

/** Every registered brain-tool name — the ACTUAL dispatchable surface, for invariant tests. */
export function registeredBrainToolNames(): readonly string[] {
  return [...DECLARED.keys()];
}

/** name → stage for the tools that MOVE the canvas rail, derived from `advancesStage`. Auxiliary
 *  reads are absent on purpose so the rail doesn't jump backward on an incidental lookup. */
export function stageAdvancingTools(): ReadonlyMap<string, FactoryStage> {
  const out = new Map<string, FactoryStage>();
  for (const [name, effect] of DECLARED)
    if (effect.advancesStage && effect.gate !== "any")
      out.set(name, effect.gate);
  return out;
}

/**
 * True when a completed tool call must be made durable AT ONCE (see the header).
 *
 * Pass the resolved descriptor when you have one so a caller-supplied tool (runBrain's `opts.tools`)
 * is judged by its own declaration. Canonical registrations win, so a caller cannot re-declare
 * `sandbox_run` as cheap and skip its checkpoint.
 *
 * FAIL CLOSED: with neither a registration nor a declaration, this yields `true`. The old
 * hand-authored set fell back to "not side-effecting", which is the wrong default for a durability
 * guard — guessing wrong costs one redundant upsert in one direction and a duplicated real-world
 * effect in the other.
 */
export function isSideEffectTool(toolName: string, tool?: BrainTool): boolean {
  const effect = DECLARED.get(toolName) ?? tool?.effect;
  return effect ? effect.checkpoint === "immediate" : true;
}

/** The derived side-effecting set. A FUNCTION, not a const, because the derivation is only complete
 *  after registration — a module-eval snapshot would silently be empty. */
export function sideEffectToolNames(): ReadonlySet<string> {
  const out = new Set<string>();
  for (const [name, effect] of DECLARED)
    if (effect.checkpoint === "immediate") out.add(name);
  return out;
}

function sameEffect(a: BrainToolEffect, b: BrainToolEffect): boolean {
  return (
    a.sideEffect === b.sideEffect &&
    a.scope === b.scope &&
    a.checkpoint === b.checkpoint &&
    a.gate === b.gate &&
    !!a.advancesStage === !!b.advancesStage
  );
}

function describeEffect(effect: BrainToolEffect): string {
  return `${effect.sideEffect}/${effect.scope}/${effect.checkpoint}/gate:${effect.gate}`;
}
