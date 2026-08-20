/**
 * #PROBE-DEFER — separating "not verified yet" from "verified and wrong".
 *
 * An integration probe can fail for reasons that mean opposite things:
 *
 *   the service never answered   → it may simply not be deployed yet
 *   the service answered "no"    → our credential or wiring is wrong
 *   there is no credential       → there is nothing to probe with
 *
 * Collapsing those into one "unverified" state has a concrete cost. The FDE
 * workflow this module exists for: an engineer holds a RAAS API key and is
 * wiring generated agents against it while RAAS itself has not been stood up.
 * No probe can succeed, yet the wiring is correct and the work must proceed.
 * Blocking it would gate our authoring on someone else's deploy schedule.
 *
 * So: a service that never answered is a SCHEDULE fact and may be deferred, if
 * a credential exists to defer. A service that answered and rejected us is a
 * CONFIGURATION fact and may not. And nothing is ever deferred into production —
 * deferral is an authoring convenience, and the promotion gate keeps its teeth.
 *
 * The vocabulary is deliberately the one the integration probe already emits
 * (`network` / `http_5xx` / `http_4xx` / `rate_limit` / `needs_config` /
 * `authorization_required` / `schema_mismatch` / `verified`), so this reads
 * existing data rather than asking anyone to annotate something new.
 */

export type ProbeDisposition =
  /** A live probe succeeded. */
  | "verified"
  /** Nothing answered, or the far side is failing at its own layer. Deferrable. */
  | "service_unreachable"
  /** The service answered and refused: credential, path, or request shape. */
  | "rejected"
  /** No credential is configured, so there is nothing to probe with. */
  | "credential_missing"
  /** A human grant is required before a probe may even be attempted. */
  | "authorization_required"
  /** No probe has ever been attempted. */
  | "never_probed"
  /** A classification this module does not recognise. Never deferrable. */
  | "unknown";

export interface ProbeObservation {
  /** `IntegrationProbeResult["classification"]`, passed through verbatim. */
  classification?: string | null;
  /** HTTP status when the far side answered. */
  status?: number | null;
}

/**
 * Read what the probe saw. Unrecognised input yields `unknown` rather than a
 * guess — an unclassifiable failure must not become a deferral.
 */
export function probeDispositionOf(observation: ProbeObservation): ProbeDisposition {
  const classification =
    typeof observation.classification === "string" ? observation.classification : undefined;
  if (!classification) return "never_probed";

  switch (classification) {
    case "verified":
      return "verified";
    case "needs_config":
      return "credential_missing";
    case "authorization_required":
      return "authorization_required";
    case "network":
    case "http_5xx":
    case "rate_limit":
      // Rate limiting is the far side declining to serve us right now, not a
      // statement that our configuration is wrong.
      return "service_unreachable";
    case "http_4xx":
      // Deliberately NOT split by status. A 404 is a wiring defect, not an
      // outage — a missing `/api/v1` base prefix once read as "service down"
      // for days. Every 4xx means the service answered, so every 4xx is ours.
      return "rejected";
    case "schema_mismatch":
      return "rejected";
    default:
      return "unknown";
  }
}

export interface ProbeDeferralContext {
  /** Whether a credential is actually configured for this integration. */
  credentialConfigured: boolean;
  /** True when this decision governs a production promotion or dispatch. */
  production?: boolean;
}

/**
 * May this probe failure be deferred?
 *
 * Only an unreachable service, only with a credential in hand, and never for
 * production. Everything else is a real finding that must not be waved through.
 */
export function isProbeDeferrable(
  disposition: ProbeDisposition,
  context: ProbeDeferralContext,
): boolean {
  if (context.production) return false;
  if (!context.credentialConfigured) return false;
  return disposition === "service_unreachable";
}

export interface ProbeDeferralNoticeInput {
  toolName: string;
  disposition: ProbeDisposition;
  /** When the probe was last attempted, unix ms. */
  attemptedAt?: number | null;
  /** Optional service/system label, when the caller knows it. */
  system?: string | null;
}

/**
 * The line an FDE reads. It must never imply verification, and it must state
 * the consequence — a deferral that reads like a pass is worse than a refusal.
 * Returns `undefined` when the state is not a deferral at all.
 */
export function probeDeferralNotice(
  input: ProbeDeferralNoticeInput,
): string | undefined {
  if (input.disposition !== "service_unreachable") return undefined;
  const target = input.system ? `${input.system}（${input.toolName}）` : input.toolName;
  const when =
    typeof input.attemptedAt === "number" && Number.isFinite(input.attemptedAt)
      ? new Date(input.attemptedAt).toISOString()
      : null;
  return [
    `[探针延后] ${target}：凭证已配置，但探测时服务没有应答${when ? `（最后尝试 ${when}）` : ""}。`,
    "这被记为「延后验证」而不是「已验证」——接线可以继续，但晋升到生产前必须补一次真实的 live probe。",
  ].join("");
}
