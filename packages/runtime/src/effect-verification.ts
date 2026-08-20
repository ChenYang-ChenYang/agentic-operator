/**
 * #EFFECT-READBACK (D6, half b) — confirm a claimed write by reading it back.
 *
 * A tool's `is_error: false` is the tool's own word for what happened. Until
 * now nothing in the run path asked anybody else. The lesson is already in
 * CLAUDE.md: RoboHire's `match-resume` wraps its analysis under `data.data.*`,
 * our normalizer read one level too shallow, and every candidate came back
 * `matchScore: null` while the call "succeeded" — the rubric then marked
 * everyone ERROR. A tool that reports success while returning nothing usable
 * has to be catchable.
 *
 * The rules this module holds itself to:
 *
 *  · The confirmation route is DECLARED — on the tool catalog entry, or on the
 *    manifest `tool_use[]` entry when the confirming endpoint is tenant-bound.
 *    There is no name list here and no inference from a tool's name.
 *  · An absent or malformed declaration is `not_verified` with a reason. It is
 *    never a silent pass, and "not verified" never renders as "verified".
 *  · A read-back that could not have observed anything real — because the write
 *    was gated/mocked, or because the read itself would be gated/mocked — is
 *    `not_verified`, not `verified`. A simulated observation is not evidence.
 *  · The read tool must be inside the same `tool_use[]` allow-list. A read-back
 *    confirms a call; it must not widen the trust boundary that authorized it.
 */

import {
  isToolEffectVerificationContract,
  type ToolEffectVerificationContract,
} from "@agentic/tools/registry";
import { safeProbePath } from "@agentic/shared";

export type { ToolEffectVerificationContract };

/** Where the honoured declaration came from. Recorded so an operator can tell
 * a tenant binding from the shipped default without re-deriving it. */
export type EffectVerificationSource = "manifest" | "catalog";

/**
 * Why an effect was not read back. Every value is a fact about THIS call —
 * none of them can be produced by a tool asserting its own success.
 */
export type EffectVerificationUnverifiedReason =
  /** No contract on the manifest entry and none on the catalog entry. */
  | "not_declared"
  /** A contract exists but does not satisfy the structural guard. */
  | "declaration_invalid"
  /** The declared read tool is not in this agent's `tool_use[]` allow-list. */
  | "read_tool_not_allowed"
  /** An ontology rule gate governs the read tool and would refuse this call.
   * A read-back must not perform a call the main dispatch path would block. */
  | "read_tool_gate_refused"
  /** The declared read tool resolved to no handler in any registry. */
  | "read_tool_unresolved"
  /** The write itself was gated, stubbed or replayed — nothing was written. */
  | "write_not_real"
  /** The write returned an error; there is no claimed effect to confirm. */
  | "write_errored"
  /** The read-back would itself have been gated/stubbed/replayed. */
  | "readback_not_real"
  /** The read tool threw. An unread effect is unverified, never verified. */
  | "readback_failed"
  /** A `readArgs` path resolved to nothing on the write call. */
  | "readback_args_unresolved";

export interface EffectVerificationCheck {
  claim: string;
  observed: string;
  agreed: boolean;
  claimValue?: unknown;
  observedValue?: unknown;
}

/**
 * The durable verdict attached to one tool call. `status` is the only field a
 * consumer needs to decide whether an effect was evidenced; the rest explains
 * it. Emitted only for write-capable calls — a read tool has no claimed effect
 * to confirm, and inventing a receipt for it would dilute the count.
 */
export interface EffectVerificationReceipt {
  status: "verified" | "disagreed" | "not_verified";
  source?: EffectVerificationSource;
  readTool?: string;
  reason?: EffectVerificationUnverifiedReason;
  detail?: string;
  checks?: EffectVerificationCheck[];
}

export interface ResolvedEffectVerificationContract {
  contract: ToolEffectVerificationContract;
  source: EffectVerificationSource;
}

/**
 * Pick the contract that governs this call.
 *
 * The manifest wins when it declares one, because the confirming endpoint is
 * routinely tenant-bound (a different base URL, a different id field) and the
 * shipped catalog cannot know it. This is not a weakening: before this module
 * existed there was no read-back at all, and BOTH sources are reviewed
 * declarations rather than model output.
 *
 * A present-but-malformed declaration is reported, never skipped — silently
 * falling through to the other source would let a typo read as "the tool
 * simply declares nothing".
 */
export function resolveEffectVerificationContract(args: {
  manifest?: unknown;
  catalog?: unknown;
}):
  | { ok: true; resolved: ResolvedEffectVerificationContract }
  | { ok: false; reason: "not_declared" | "declaration_invalid"; detail?: string } {
  const { manifest, catalog } = args;
  if (manifest !== undefined && manifest !== null) {
    return isToolEffectVerificationContract(manifest)
      ? { ok: true, resolved: { contract: manifest, source: "manifest" } }
      : {
          ok: false,
          reason: "declaration_invalid",
          detail: "manifest tool_use[].effect_verification is malformed",
        };
  }
  if (catalog !== undefined && catalog !== null) {
    return isToolEffectVerificationContract(catalog)
      ? { ok: true, resolved: { contract: catalog, source: "catalog" } }
      : {
          ok: false,
          reason: "declaration_invalid",
          detail: "catalog effectVerification is malformed",
        };
  }
  return { ok: false, reason: "not_declared" };
}

/** Read a safe dotted path. `undefined` means "no value at that path" — the
 * caller must not be able to confuse that with a legitimately stored null. */
export function readEffectPath(
  root: unknown,
  path: string,
): { found: boolean; value?: unknown } {
  if (!safeProbePath(path)) return { found: false };
  let cursor: unknown = root;
  for (const segment of path.split(".")) {
    if (cursor === null || typeof cursor !== "object") return { found: false };
    if (!Object.prototype.hasOwnProperty.call(cursor, segment)) {
      return { found: false };
    }
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return { found: true, value: cursor };
}

/**
 * Build the read tool's arguments from the write call itself. Sources are
 * limited to `input.*` / `output.*` of the same call by the structural guard,
 * so a declaration can never confirm an effect using ambient state it did not
 * observe.
 */
export function resolveReadbackArgs(
  contract: ToolEffectVerificationContract,
  call: { input?: unknown; output?: unknown },
): { ok: true; args: Record<string, unknown> } | { ok: false; missing: string[] } {
  const args: Record<string, unknown> = {};
  const missing: string[] = [];
  for (const [name, path] of Object.entries(contract.readArgs ?? {})) {
    const [head, ...rest] = path.split(".");
    const root = head === "input" ? call.input : head === "output" ? call.output : undefined;
    const read = readEffectPath(root, rest.join("."));
    if (!read.found) {
      missing.push(`${name}<-${path}`);
      continue;
    }
    args[name] = read.value;
  }
  return missing.length > 0 ? { ok: false, missing } : { ok: true, args };
}

/**
 * Compare what the write CLAIMED against what the read OBSERVED.
 *
 * A path that resolves to nothing counts as a disagreement, not as a skipped
 * check: "the field the caller relies on isn't there" is precisely the
 * `matchScore: null` failure, and treating it as absence-of-evidence would let
 * the original bug through again.
 */
export function compareEffectReadback(
  contract: ToolEffectVerificationContract,
  values: { claim: unknown; observed: unknown },
): { agreed: boolean; checks: EffectVerificationCheck[] } {
  const checks: EffectVerificationCheck[] = [];
  for (const pair of contract.match) {
    const claimed = readEffectPath(values.claim, pair.claim);
    const seen = readEffectPath(values.observed, pair.observed);
    const agreed =
      claimed.found && seen.found && deepEqual(claimed.value, seen.value);
    checks.push({
      claim: pair.claim,
      observed: pair.observed,
      agreed,
      ...(claimed.found ? { claimValue: claimed.value } : {}),
      ...(seen.found ? { observedValue: seen.value } : {}),
    });
  }
  return { agreed: checks.every((check) => check.agreed), checks };
}

/** Structural equality over JSON values. Key order is irrelevant; a missing
 * key and an explicit `undefined` are deliberately NOT interchangeable. */
function deepEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) return false;
    return (
      left.length === right.length
      && left.every((item, index) => deepEqual(item, right[index]))
    );
  }
  if (
    left === null
    || right === null
    || typeof left !== "object"
    || typeof right !== "object"
  ) {
    return false;
  }
  const leftKeys = Object.keys(left as Record<string, unknown>).sort();
  const rightKeys = Object.keys(right as Record<string, unknown>).sort();
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every(
    (key, index) =>
      key === rightKeys[index]
      && deepEqual(
        (left as Record<string, unknown>)[key],
        (right as Record<string, unknown>)[key],
      ),
  );
}

/** Convenience constructor so every unverified path produces the same shape
 * and nobody can accidentally omit `status`. */
export function unverifiedEffect(
  reason: EffectVerificationUnverifiedReason,
  extra: Omit<EffectVerificationReceipt, "status" | "reason"> = {},
): EffectVerificationReceipt {
  return { status: "not_verified", reason, ...extra };
}
