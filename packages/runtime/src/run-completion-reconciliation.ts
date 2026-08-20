/**
 * #RUN-EVIDENCE (D6, half a) — reconcile what a run CLAIMS against its ledger.
 *
 * The measured defect: a production run flipped to `ok` when every step body
 * returned without throwing and the mandatory terminal artifacts persisted.
 * `outputValid` was a schema check on the terminal payload (v2 agents only).
 * There was no read-back of a claimed external write, no critic, and no
 * reconciliation against the tool-call ledger — `ok` could only ever mean
 * "nothing threw".
 *
 * The BUILD path already knows how to do this: `assertRegressionArtifactCassette
 * Evidence` / `replayRegressionArtifact` derive an `evidenceQualification` the
 * caller cannot self-assert, and "a local worker green result is not
 * promotable". This module brings the same discipline to the run path.
 *
 * ── Why QUALIFY instead of FAIL ──────────────────────────────────────────────
 * `failed` already means something specific and load-bearing (retries,
 * compensation, operator triage). Flipping today's healthy runs to `failed`
 * because their tools never declared a read-back would be a behaviour change
 * dressed up as a fix. So the default outcome of an unevidenced completion is
 * a QUALIFIED completion: a durable, server-derived statement of what was and
 * was not evidenced, persisted beside the run and impossible for the agent to
 * assert for itself. `ok` therefore stops being able to mean "nothing threw" —
 * every ok run now also carries the answer to "evidenced by what?".
 *
 * An operator who wants the stronger posture sets
 * `AGENTIC_RUN_COMPLETION_ENFORCEMENT=refuse`, exactly mirroring the
 * `AGENTIC_TOOL_PROBE_ENFORCEMENT` / rule-gate convention: report by default
 * because turning a deployed fleet fail-closed is an operational decision, not
 * something a runtime upgrade performs silently.
 *
 * ── Derivation, not recomputation ───────────────────────────────────────────
 * Every entry comes from `toolLedgerEntryFromAuditRecord`, which reads the
 * EXACT record `buildToolCallAuditRecord` persisted as
 * `step-<ord>-tool-<k>.json`. Nothing here re-derives a verdict from the live
 * objects the writer saw; if the writer did not record it, the reconciliation
 * says so rather than inventing it.
 */

export const RUN_COMPLETION_RECONCILIATION_SCHEMA =
  "agentic-run-completion-reconciliation/v1" as const;

/**
 * One tool call, as read back off the persisted audit record. Deliberately a
 * projection of the record rather than of the in-memory `ToolCallTrace`: the
 * record is what an auditor can re-read tomorrow.
 */
export interface ToolCallLedgerEntry {
  name: string;
  /** Artifact this entry was projected from, so a qualification is traceable
   * to a file on disk rather than to a number in a summary. */
  evidence: string;
  step?: string;
  isError: boolean;
  /**
   * `live` (or absent, which is the non-sandbox production shape) means the
   * handler really ran. Anything else — `replay`, `gate_profile`, `gate_grant`,
   * `mock` — is a simulated dispatch and must never count as real evidence.
   */
  sandboxDecision?: string;
  real: boolean;
  /** True when the tool's reviewed/declared semantics can mutate external
   * state. Sourced from the declaration, never from the tool's name. */
  writeCapable: boolean;
  /** A guarded call that an enforcing rule gate would have refused. */
  ruleGateUnsatisfied: boolean;
  /** A call whose required live probe was not verified at dispatch. */
  probeUnverified: boolean;
  /** Read-back verdict, present only for write-capable calls. */
  effectVerification?: {
    status: "verified" | "disagreed" | "not_verified";
    reason?: string;
    readTool?: string;
  };
}

/** A step the tool-call evidence writer structurally does not cover, so its
 * tool activity (if any) is absent from the ledger. Named rather than ignored:
 * silence about a step is not the same as a step that used no tools.
 *
 * ONE hole remains. Foreach used to be the other (`nested_actions_not_
 * recorded`): body actions ran as their own durable steps outside the per-call
 * evidence writer, permanently qualifying every batch run. Foreach body steps
 * now run through the SAME writer inside their durable step (item-unique
 * `step-<ord>-foreach-<childStepId>-tool-<k>.json` artifacts), and containers
 * aggregate their children's ledger entries — so foreach is real counting, not
 * a declared gap. */
export interface UncoveredStep {
  ord: number;
  name: string;
  type: string;
  reason:
    /** Generated code dispatched tools over the host RPC bridge. The bridge
     * classifies each dispatch but does not carry its input/output, so no
     * per-call audit record can be written for them without inventing one.
     * Still declared, deliberately — NOT fixed by the foreach work. */
    "generated_code_dispatch_not_recorded";
}

export type RunCompletionQualificationCode =
  /** The agent declares write-capable tools, yet no real write call reached
   * the ledger. Its terminal output implies an effect nothing recorded. */
  | "declared_write_unrecorded"
  /** A real write completed with no verified read-back. */
  | "effect_not_read_back"
  /** A read-back ran and disagreed with the claimed effect. */
  | "effect_readback_disagreed"
  /** At least one tool call returned an error. */
  | "tool_call_errored"
  /** At least one dispatch was gated, stubbed or replayed rather than real. */
  | "tool_dispatch_simulated"
  /** At least one guarded call carried an unsatisfied rule-gate finding. */
  | "rule_gate_unsatisfied"
  /** At least one call ran against an unverified live probe. */
  | "probe_unverified"
  /** A step ran whose tool activity the evidence writer does not record. */
  | "tool_evidence_coverage_incomplete";

export interface RunCompletionQualification {
  code: RunCompletionQualificationCode;
  detail: string;
}

export interface RunCompletionReconciliation {
  schema: typeof RUN_COMPLETION_RECONCILIATION_SCHEMA;
  /**
   * `evidenced` — every claim this run makes is backed by a recorded, real,
   * unrefuted call, and every real write was read back.
   * `qualified`  — the run completed, and here is exactly what was not proven.
   * Server-derived from the persisted ledger; a run cannot assert it.
   */
  outcome: "evidenced" | "qualified";
  toolCalls: {
    dispatched: number;
    errored: number;
    /** Dispatches that really executed. Never includes gated/mocked calls. */
    real: number;
    simulated: number;
    /** Count per recorded dispatch decision, so `replay` and `gate_grant` stay
     * distinguishable instead of collapsing into one "not live" bucket. */
    byDecision: Record<string, number>;
  };
  writes: {
    /** Write-capable tools this agent DECLARED it may call. */
    declaredTools: string[];
    /** Recorded write-capable calls, of any disposition. */
    recorded: number;
    /** Recorded write-capable calls that really ran and did not error. */
    recordedReal: number;
    readBackVerified: number;
    readBackDisagreed: number;
    readBackNotVerified: number;
    /** Why write calls went unverified, tallied by reason so "nobody declared
     * a read-back" is distinguishable from "the read tool wasn't allowed". */
    notVerifiedReasons: Record<string, number>;
  };
  coverage: {
    source: "manifest_tool_call_evidence";
    /** Artifact names the ledger was projected from. */
    evidence: string[];
    uncoveredSteps: UncoveredStep[];
  };
  qualifications: RunCompletionQualification[];
}

/**
 * Project one persisted audit record into a ledger entry.
 *
 * The argument is the object `buildToolCallAuditRecord` returned and
 * `writeArtifact` persisted — same call site, same bytes. Fields are read
 * defensively because this shape crosses a persistence boundary, and every
 * unreadable field fails toward "not evidenced".
 */
export function toolLedgerEntryFromAuditRecord(
  record: Record<string, unknown>,
  context: { evidence: string; step?: string; writeCapable: boolean },
): ToolCallLedgerEntry {
  const dispatch = asRecord(record.dispatch);
  const rawDecision = dispatch?.sandbox_decision;
  const sandboxDecision = typeof rawDecision === "string" ? rawDecision : undefined;
  const isError = record.is_error === true;
  const ruleGate = asRecord(record.rule_gate);
  const probe = asRecord(record.probe);
  const effect = asRecord(record.effect_verification);
  const effectStatus = effect?.status;
  return {
    name: typeof record.name === "string" ? record.name : "(unnamed)",
    evidence: context.evidence,
    ...(context.step ? { step: context.step } : {}),
    isError,
    ...(sandboxDecision ? { sandboxDecision } : {}),
    // Absent decision is the ordinary production shape (no sandbox involved).
    // Any recorded decision other than `live` is a simulated dispatch.
    real: sandboxDecision === undefined || sandboxDecision === "live",
    writeCapable: context.writeCapable,
    // `wouldRefuse` stays true in report mode — that is the whole point of
    // report mode, and a completion must not read clean because the gate was
    // configured not to block.
    ruleGateUnsatisfied:
      ruleGate?.allowed === false
      || ruleGate?.wouldRefuse === true
      || countOf(ruleGate?.refusals) > 0,
    // `requires_probe: false` never reaches the record; when a probe block is
    // present at all, `verified !== true` means it was not proven.
    probeUnverified: probe !== undefined && probe.verified !== true,
    ...(effectStatus === "verified"
    || effectStatus === "disagreed"
    || effectStatus === "not_verified"
      ? {
          effectVerification: {
            status: effectStatus,
            ...(typeof effect?.reason === "string" ? { reason: effect.reason } : {}),
            ...(typeof effect?.read_tool === "string"
              ? { readTool: effect.read_tool }
              : {}),
          },
        }
      : {}),
  };
}

/**
 * Derive the completion verdict. Pure and total: given the same ledger it
 * always produces the same statement, which is what makes it something a run
 * cannot talk its way out of.
 */
export function reconcileRunCompletion(input: {
  ledger: readonly ToolCallLedgerEntry[];
  /** Write-capable tools the agent DECLARED. Derived by the caller from the
   * reviewed execution policy / declared side-effect, never from names. */
  declaredWriteTools: readonly string[];
  uncoveredSteps?: readonly UncoveredStep[];
}): RunCompletionReconciliation {
  const ledger = [...input.ledger];
  const declaredWriteTools = [...new Set(input.declaredWriteTools)].sort();
  const uncoveredSteps = [...(input.uncoveredSteps ?? [])];

  const byDecision: Record<string, number> = {};
  for (const entry of ledger) {
    const key = entry.sandboxDecision ?? "live";
    byDecision[key] = (byDecision[key] ?? 0) + 1;
  }
  const errored = ledger.filter((entry) => entry.isError);
  const simulated = ledger.filter((entry) => !entry.real);
  const writes = ledger.filter((entry) => entry.writeCapable);
  const realWrites = writes.filter((entry) => entry.real && !entry.isError);
  const notVerifiedReasons: Record<string, number> = {};
  let readBackVerified = 0;
  let readBackDisagreed = 0;
  let readBackNotVerified = 0;
  for (const entry of realWrites) {
    const status = entry.effectVerification?.status;
    if (status === "verified") readBackVerified += 1;
    else if (status === "disagreed") readBackDisagreed += 1;
    else {
      readBackNotVerified += 1;
      // A write whose record carries no verification block at all is not a
      // gap in this function — it is a write nobody asked about.
      const reason = entry.effectVerification?.reason ?? "not_recorded";
      notVerifiedReasons[reason] = (notVerifiedReasons[reason] ?? 0) + 1;
    }
  }

  const qualifications: RunCompletionQualification[] = [];
  if (declaredWriteTools.length > 0 && realWrites.length === 0) {
    qualifications.push({
      code: "declared_write_unrecorded",
      detail: `agent declares write-capable tool(s) ${declaredWriteTools.join(", ")}, and the ledger recorded no real write call`,
    });
  }
  if (readBackDisagreed > 0) {
    qualifications.push({
      code: "effect_readback_disagreed",
      detail: `${readBackDisagreed} write(s) were read back and the observed state did not match the claim: ${describe(
        realWrites.filter((entry) => entry.effectVerification?.status === "disagreed"),
      )}`,
    });
  }
  if (readBackNotVerified > 0) {
    qualifications.push({
      code: "effect_not_read_back",
      detail: `${readBackNotVerified} real write(s) completed with no verified read-back (${Object.entries(
        notVerifiedReasons,
      )
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([reason, count]) => `${reason}×${count}`)
        .join(", ")})`,
    });
  }
  if (errored.length > 0) {
    qualifications.push({
      code: "tool_call_errored",
      detail: `${errored.length} tool call(s) returned an error: ${describe(errored)}`,
    });
  }
  if (simulated.length > 0) {
    qualifications.push({
      code: "tool_dispatch_simulated",
      detail: `${simulated.length} dispatch(es) were gated, stubbed or replayed rather than executed: ${describe(simulated)}`,
    });
  }
  const gated = ledger.filter((entry) => entry.ruleGateUnsatisfied);
  if (gated.length > 0) {
    qualifications.push({
      code: "rule_gate_unsatisfied",
      detail: `${gated.length} call(s) carried an unsatisfied rule-gate finding: ${describe(gated)}`,
    });
  }
  const unprobed = ledger.filter((entry) => entry.probeUnverified);
  if (unprobed.length > 0) {
    qualifications.push({
      code: "probe_unverified",
      detail: `${unprobed.length} call(s) ran against an unverified live probe: ${describe(unprobed)}`,
    });
  }
  if (uncoveredSteps.length > 0) {
    qualifications.push({
      code: "tool_evidence_coverage_incomplete",
      detail: `${uncoveredSteps.length} step(s) run their actions outside the tool-call evidence writer, so their tool activity is absent from this ledger: ${uncoveredSteps
        .map((step) => `${step.ord}:${step.name}(${step.type})`)
        .join(", ")}`,
    });
  }

  return {
    schema: RUN_COMPLETION_RECONCILIATION_SCHEMA,
    outcome: qualifications.length === 0 ? "evidenced" : "qualified",
    toolCalls: {
      dispatched: ledger.length,
      errored: errored.length,
      real: ledger.length - simulated.length,
      simulated: simulated.length,
      byDecision,
    },
    writes: {
      declaredTools: declaredWriteTools,
      recorded: writes.length,
      recordedReal: realWrites.length,
      readBackVerified,
      readBackDisagreed,
      readBackNotVerified,
      notVerifiedReasons,
    },
    coverage: {
      source: "manifest_tool_call_evidence",
      evidence: ledger.map((entry) => entry.evidence),
      uncoveredSteps,
    },
    qualifications,
  };
}

export type RunCompletionEnforcement = "report" | "refuse";

/**
 * `report` is the default for the same reason the rule gate and the probe gate
 * report by default: a runtime upgrade must not silently start failing a fleet
 * of already-deployed agents. Reporting is not silence — the qualification is
 * durable terminal evidence on every single run.
 */
export function runCompletionEnforcementFromEnv(
  env: Record<string, string | undefined>,
): RunCompletionEnforcement {
  return env.AGENTIC_RUN_COMPLETION_ENFORCEMENT?.trim().toLowerCase() === "refuse"
    ? "refuse"
    : "report";
}

/** One-line operator summary. Used in the run log and the terminal trace so a
 * qualified completion is visible without opening the artifact. */
export function summarizeRunCompletion(
  reconciliation: RunCompletionReconciliation,
): string {
  const { toolCalls, writes } = reconciliation;
  const head =
    reconciliation.outcome === "evidenced"
      ? "完成已被证据支持"
      : "完成未被完全证据支持";
  return `${head}：工具调用 ${toolCalls.dispatched}（真实 ${toolCalls.real} / 模拟 ${toolCalls.simulated} / 出错 ${toolCalls.errored}）· 真实写入 ${writes.recordedReal}（已回读校验 ${writes.readBackVerified}）${
    reconciliation.qualifications.length
      ? ` · 未证实：${reconciliation.qualifications.map((item) => item.code).join(", ")}`
      : ""
  }`;
}

function describe(entries: readonly ToolCallLedgerEntry[]): string {
  return entries
    .slice(0, 8)
    .map((entry) => `${entry.name}@${entry.evidence}`)
    .join(", ");
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function countOf(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}
