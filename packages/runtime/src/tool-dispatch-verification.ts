/**
 * #DISPATCH-VERIFY — dispatch-time tool verification and a subjectified call record.
 *
 * Two related gaps, both about the same thing: what the runtime knows at the
 * moment it runs a tool, versus what it checked and what it wrote down.
 *
 * PROBE VERIFICATION (D8). Integration probes are verified thoroughly, but only
 * at promote time: `production-integration-probe-gate` runs from `promote.ts`
 * and `draft-review.ts`, demanding the exact current production live-probe hash.
 * At run time, `bootstrap.ts` rebuilds each persisted tool into a descriptor
 * from `method/urlTemplate/headers/bodyTemplate/requestSpec/responseSpec/
 * paramsSchema/returnsSchema` plus the policy triple — and drops `probeStatus`,
 * `definitionHash`, `probeEvidence`, `verifiedAt`. A probe that has since failed,
 * expired, or that attested a definition the tool no longer has therefore does
 * not stop anything. Verification that only happens before deployment is not
 * verification of what is running.
 *
 * CALL RECORD (D9). Every tool call already persists
 * `step-<ord>-tool-<k>.json` with `{tool_call_id, name, input, output, is_error,
 * duration_ms}`, a `run_trace_events` row, and an NDJSON line. That answers
 * "what ran and how long it took" but not "who ran it, under what authority,
 * against which version, and what was checked first" — the questions an audit of
 * an agent's trajectory actually asks. The legacy keys are preserved exactly;
 * the new information is additive.
 */

import { createHash } from "node:crypto";
import {
  normalizeToolSchema,
  validateToolSchema,
  type SchemaValidationIssue,
} from "@agentic/tools";
import {
  isProbeDeferrable,
  probeDeferralNotice,
  probeDispositionOf,
  type ProbeDisposition,
} from "@agentic/shared";
import type { EffectVerificationReceipt } from "./effect-verification";

/**
 * #ARG-CONTRACT (D3) — validate the TYPES of the arguments a model supplied,
 * without enforcing `required`.
 *
 * The omission is deliberate and load-bearing. Arguments legitimately arrive
 * from three places, only one of which is the model: `ctx.config` carries
 * per-tenant values from the manifest, and `ctx.lastResult` carries payloads
 * server-side (that is how a multi-KB base64 PDF reaches the resume parser
 * without the model re-quoting and corrupting it). Validating the model's args
 * against `required` would reject those calls. So this catches the failure mode
 * that is unambiguously the model's — a wrongly-typed value — and leaves
 * required-ness to the manifest's own `input_schema`, whose behaviour is
 * unchanged.
 *
 * Reuses the existing `validateToolSchema` so there is ONE validation semantics
 * in the codebase, and accepts both the JSON-Schema and factory field-map forms
 * because both are real on-disk shapes.
 */
export function validateSuppliedArgTypes(
  schema: Record<string, unknown> | undefined,
  args: unknown,
): SchemaValidationIssue[] {
  if (!schema || Object.keys(schema).length === 0) return [];
  if (args == null || typeof args !== "object" || Array.isArray(args)) return [];
  // Normalize FIRST, so both authored representations become one JSON Schema and
  // there is no ambiguous branch to get wrong. Deciding "field map or JSON
  // Schema?" by looking for a `type`/`required`/`properties` key breaks on a real
  // field map whose field is literally named `type` or `required` — it either
  // disables validation entirely or reinstates the required-ness we must drop.
  const normalized = normalizeToolSchema(schema);
  if (!normalized) return [];
  return validateToolSchema(args, stripRequiredDeep(normalized));
}

/**
 * Remove every `required` constraint, at every depth. Nested matters as much as
 * top level: the resume chain hands `{payload:{pdf_base64}}` to the parser via
 * `ctx.lastResult`, so a nested `required: ["pdf_base64"]` would reject a
 * perfectly legitimate call in which the model supplied only the sibling fields.
 * Only the JSON-Schema `required` KEYWORD is dropped — a property genuinely
 * named "required" inside `properties` is left alone.
 */
function stripRequiredDeep(schema: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === "required") continue;
    // `properties` is a map of NAMES, so its keys are author data, not keywords:
    // recurse into each value, never treat a property name as a keyword.
    if (key === "properties" && isRecord(value)) {
      const props: Record<string, unknown> = {};
      for (const [name, spec] of Object.entries(value)) {
        props[name] = isRecord(spec) ? stripRequiredDeep(spec) : spec;
      }
      out.properties = props;
      continue;
    }
    out[key] = stripRequiredValue(value);
  }
  return out;
}

function stripRequiredValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripRequiredValue);
  return isRecord(value) ? stripRequiredDeep(value) : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Values written by the factory tool store: "required" | "verified" | "failed". */
export interface ToolProbeState {
  probeStatus?: string | null;
  definitionHash?: string | null;
  verifiedAt?: number | null;
  /**
   * #PROBE-DEFER — what the last probe actually SAW, in the integration probe's
   * own vocabulary (`network` / `http_4xx` / `needs_config` / …). Without it a
   * service that is merely not deployed yet is indistinguishable from a rejected
   * credential, and an FDE wiring a real key against a service that has not been
   * stood up gets blocked on someone else's deploy schedule.
   */
  classification?: string | null;
  /** Whether a credential is configured for this integration at all. */
  credentialConfigured?: boolean | null;
}

export interface ProbeVerificationIssue {
  code:
    | "probe_state_missing"
    | "probe_not_verified"
    | "probe_definition_drift"
    | "probe_expired"
    /** The service never answered — deferrable when a credential exists. */
    | "probe_service_unreachable"
    /** The service answered and refused: credential, path, or request shape. */
    | "probe_rejected"
    /** No credential is configured, so there is nothing to probe with. */
    | "probe_credential_missing";
  detail: string;
}

export interface ProbeVerificationResult {
  requiresProbe: boolean;
  verified: boolean;
  issues: ProbeVerificationIssue[];
  /** What the last probe saw, so callers need not re-derive it. */
  disposition?: ProbeDisposition;
  /**
   * #PROBE-DEFER — true when this failure may be carried as a recorded
   * obligation instead of a block: an unreachable service, a configured
   * credential, and not production. Never implies verification.
   */
  deferrable: boolean;
  /** The line an FDE reads when a deferral applies. */
  deferralNotice?: string;
}

export interface ProbeVerificationInput {
  toolName: string;
  /** From the reviewed execution policy — never inferred from the tool's name. */
  sideEffect?: string | null;
  effectScope?: string | null;
  /** Probe state as persisted. `undefined` means it never reached the runtime. */
  probe?: ToolProbeState;
  /** Hash of the definition actually about to be dispatched, when known. */
  currentDefinitionHash?: string | null;
  nowMs: number;
  /** Declared freshness window. Omitted means no expiry is checked — an expiry
   * this module invented would be a policy decision disguised as a default. */
  ttlMs?: number;
  /** True when this dispatch is a production one. Deferral is an authoring
   * convenience and is never granted here. */
  production?: boolean;
}

/**
 * Which tools need a live probe. Derived from the reviewed policy, never a name
 * list — and calibrated against the ACTUAL vocabulary rather than a guess at it:
 *
 *   manifest `tool_use[].side_effect` = read | write | dual | call
 *   execution policy `operation`      = read | compute | write | read_write
 *   execution policy `effectScope`    = none | external | sandbox_local
 *
 * A probe attests an EXTERNAL integration, so `effectScope: "external"` is the
 * trigger. Measured against the live catalog that is exactly right: all 15
 * external tools qualify — including every `call` tool (gohireParseResumeApi,
 * generateJdApi, …), which an earlier cut missed by only looking for write-ish
 * values — while the only non-external writes are `sandbox_local` (fs.*,
 * report.htmlToPdf) and have no remote integration a probe could speak about.
 *
 * When the scope is UNDECLARED we cannot conclude "internal", so a mutating or
 * outbound tool still requires a probe: missing metadata fails closed.
 */
function probeIsRequired(input: ProbeVerificationInput): boolean {
  if (input.effectScope === "external") return true;
  if (input.effectScope === "none" || input.effectScope === "sandbox_local") return false;
  // Scope undeclared — fall back to what the tool says it does.
  return (
    input.sideEffect === "write" ||
    input.sideEffect === "dual" ||
    input.sideEffect === "call" ||
    input.sideEffect === "read_write"
  );
}

export function evaluateProbeVerification(
  input: ProbeVerificationInput,
): ProbeVerificationResult {
  const requiresProbe = probeIsRequired(input);
  if (!requiresProbe)
    return { requiresProbe: false, verified: true, issues: [], deferrable: false };

  const issues: ProbeVerificationIssue[] = [];
  const probe = input.probe;
  if (!probe) {
    issues.push({
      code: "probe_state_missing",
      detail: `tool '${input.toolName}' reached dispatch with no probe state; absence of evidence is not verification`,
    });
    return { requiresProbe, verified: false, issues, deferrable: false };
  }

  // #PROBE-DEFER — read what the probe SAW before deciding what its failure
  // means. `disposition` distinguishes a service that never answered from one
  // that answered and refused.
  const disposition = probeDispositionOf({
    classification: probe.classification,
    status: null,
  });
  const deferrable = isProbeDeferrable(disposition, {
    credentialConfigured: probe.credentialConfigured === true,
    production: input.production === true,
  });

  if (probe.probeStatus !== "verified") {
    switch (disposition) {
      case "service_unreachable":
        issues.push({
          code: "probe_service_unreachable",
          detail: `tool '${input.toolName}' could not be probed because the service did not answer${probe.credentialConfigured === true ? "（凭证已配置）" : "（且没有配置凭证）"}`,
        });
        break;
      case "rejected":
        issues.push({
          code: "probe_rejected",
          detail: `tool '${input.toolName}' was refused by the service — the credential, path, or request shape is wrong, not the deployment`,
        });
        break;
      case "credential_missing":
        issues.push({
          code: "probe_credential_missing",
          detail: `tool '${input.toolName}' has no configured credential, so no probe can be attempted`,
        });
        break;
      default:
        issues.push({
          code: "probe_not_verified",
          detail: `tool '${input.toolName}' has probe status '${probe.probeStatus ?? "(none)"}'`,
        });
        break;
    }
  }

  // A hash the probe attested is only meaningful against the definition being
  // run. Compare only when both sides are known — a missing hash is a separate
  // authoring gap, not evidence of drift.
  if (
    input.currentDefinitionHash &&
    probe.definitionHash &&
    input.currentDefinitionHash !== probe.definitionHash
  ) {
    issues.push({
      code: "probe_definition_drift",
      detail: `tool '${input.toolName}' definition changed since its probe (attested ${probe.definitionHash.slice(0, 12)}…, dispatching ${input.currentDefinitionHash.slice(0, 12)}…)`,
    });
  }

  if (
    input.ttlMs !== undefined &&
    typeof probe.verifiedAt === "number" &&
    input.nowMs - probe.verifiedAt > input.ttlMs
  ) {
    issues.push({
      code: "probe_expired",
      detail: `tool '${input.toolName}' was last verified ${Math.floor((input.nowMs - probe.verifiedAt) / 86_400_000)}d ago, beyond the declared window`,
    });
  }

  const notice = deferrable
    ? probeDeferralNotice({
        toolName: input.toolName,
        disposition,
        attemptedAt: probe.verifiedAt ?? null,
      })
    : undefined;
  return {
    requiresProbe,
    // A deferral is NOT verification. It says the block may be carried as a
    // recorded obligation, never that the integration was proven.
    verified: issues.length === 0,
    issues,
    disposition,
    deferrable,
    ...(notice ? { deferralNotice: notice } : {}),
  };
}

export type ProbeVerificationPolicy = "refuse" | "report" | "off";

/**
 * The failure mode is configuration, not code. `report` is the default for the
 * same reason the rule gate reports by default: flipping a fleet of already
 * deployed tools to fail-closed is an operational decision, and a runtime
 * upgrade must not make it silently. Reporting is still loud — the verdict lands
 * on every call record.
 */
export function probeVerificationPolicyFromEnv(
  env: Record<string, string | undefined>,
): ProbeVerificationPolicy {
  const raw = env.AGENTIC_TOOL_PROBE_ENFORCEMENT?.trim().toLowerCase();
  if (raw === "refuse" || raw === "off") return raw;
  return "report";
}

/** Deterministic, key-order-independent JSON for digesting. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

function digest(value: unknown): string {
  let serialized: string;
  try {
    serialized = JSON.stringify(canonicalize(value) ?? null) ?? "null";
  } catch {
    // A non-serializable payload still gets a stable marker rather than
    // breaking evidence persistence, which is fail-closed on IO errors.
    serialized = " unserializable";
  }
  return createHash("sha256").update(serialized).digest("hex");
}

export interface ToolCallAuditSubject {
  agentName?: string;
  agentVersionId?: string;
  ontologyActionName?: string;
  tenantSlug?: string;
  tenantId?: string;
  runId?: string;
  correlationId?: string;
  stepName?: string;
  /** Hash of the exact tool definition dispatched, when known. */
  definitionHash?: string;
  /** Hash of the workflow manifest this run was registered from. */
  workflowManifestSha256?: string;
}

export interface ToolCallAuditCall {
  id?: string;
  name: string;
  input?: unknown;
  output?: unknown;
  isError?: boolean;
  durationMs?: number;
  /** The rule-gate verdict this call was judged against, when it was guarded. */
  ruleGate?: unknown;
  /** live | replay | gate_profile | gate_grant | … — a mocked call must not read
   * like a real one in the record. */
  sandboxDecision?: string;
  resolvedVia?: string;
  /**
   * #EFFECT-READBACK (D6) — whether somebody other than the tool confirmed the
   * claimed effect. Present only for write-capable calls; `not_verified` with
   * a reason is a legitimate, expected value and must never be omitted in
   * favour of looking clean.
   */
  effectVerification?: EffectVerificationReceipt;
}

/**
 * Build the durable per-tool-call record. The six legacy keys keep their exact
 * names and positions because other consumers read them; everything else is
 * additive, and an absent block is OMITTED rather than written as `null` — a
 * null here would read as "checked, nothing to report".
 */
export function buildToolCallAuditRecord(args: {
  call: ToolCallAuditCall;
  subject: ToolCallAuditSubject;
  probe?: ProbeVerificationResult;
}): Record<string, unknown> {
  const { call, subject, probe } = args;

  const actor = {
    agent: subject.agentName ?? null,
    agent_version_id: subject.agentVersionId ?? null,
    tenant_slug: subject.tenantSlug ?? null,
    tenant_id: subject.tenantId ?? null,
    ontology_action: subject.ontologyActionName ?? null,
    run_id: subject.runId ?? null,
    correlation_id: subject.correlationId ?? null,
    step: subject.stepName ?? null,
  };

  const dispatch: Record<string, unknown> = {};
  if (call.sandboxDecision !== undefined) dispatch.sandbox_decision = call.sandboxDecision;
  if (call.resolvedVia !== undefined) dispatch.resolved_via = call.resolvedVia;

  const version: Record<string, unknown> = {};
  if (subject.definitionHash) version.definition_hash = subject.definitionHash;
  if (subject.workflowManifestSha256)
    version.workflow_manifest_sha256 = subject.workflowManifestSha256;

  return {
    tool_call_id: call.id ?? null,
    name: call.name,
    input: call.input ?? null,
    output: call.output ?? null,
    is_error: call.isError ?? false,
    duration_ms: call.durationMs ?? 0,
    actor,
    digests: {
      input_sha256: digest(call.input ?? null),
      output_sha256: digest(call.output ?? null),
    },
    ...(Object.keys(dispatch).length > 0 ? { dispatch } : {}),
    ...(Object.keys(version).length > 0 ? { version } : {}),
    ...(call.ruleGate ? { rule_gate: call.ruleGate } : {}),
    // #EFFECT-READBACK — snake_case like every other persisted block, and
    // OMITTED when the call was not write-capable. An absent block means "this
    // call claimed no effect", which is different from "the effect went
    // unverified"; the reconciliation must be able to tell them apart.
    ...(call.effectVerification
      ? {
          effect_verification: {
            status: call.effectVerification.status,
            ...(call.effectVerification.source
              ? { source: call.effectVerification.source }
              : {}),
            ...(call.effectVerification.readTool
              ? { read_tool: call.effectVerification.readTool }
              : {}),
            ...(call.effectVerification.reason
              ? { reason: call.effectVerification.reason }
              : {}),
            ...(call.effectVerification.detail
              ? { detail: call.effectVerification.detail }
              : {}),
            ...(call.effectVerification.checks
              ? { checks: call.effectVerification.checks }
              : {}),
          },
        }
      : {}),
    ...(probe
      ? {
          probe: {
            requires_probe: probe.requiresProbe,
            verified: probe.verified,
            issues: probe.issues,
          },
        }
      : {}),
  };
}
