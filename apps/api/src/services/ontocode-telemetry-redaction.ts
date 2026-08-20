// The ONE redaction boundary every Factory/OntoCode-originated string crosses
// before it lands in a durable Session sink (event, receipt, chat message, API
// response). It lived inside the Harness worker while only the worker wrote to
// those sinks; the Ontology-freshness read publishes a verbatim source failure
// reason to the same audience, and a second hand-rolled scrubber beside this
// one is exactly how a narrower vocabulary ends up leaking what the wider one
// caught. Keep a single definition and import it.

import { sanitizeSensitiveInput } from "@agentic/agent-factory";

const HARNESS_PII_KEY_RE =
  /(?:^|_)(?:email|email_address|phone|phone_number|mobile|telephone|ssn|national_id|identity_number)(?:$|_)/i;
const HARNESS_EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const HARNESS_CN_MOBILE_RE = /\b1[3-9]\d{9}\b/g;
const HARNESS_FORMATTED_PHONE_RE =
  /(?:\+\d[\d\s().-]{7,}\d|\b\d{3}[-.\s]\d{3}[-.\s]\d{4}\b)/g;
// `scheme://user:password@host` — the one credential shape the Factory's
// canonical secret scanner deliberately limits to database URLs. An Ontology
// transport quotes its own base URL back in a failure message, so an operator
// who configured basic auth would otherwise see the password republished in
// the Session. Matched as a RUN so the host and the rest of the sentence
// survive: "which endpoint failed" is the whole value of the reason.
const URL_USERINFO_RE =
  /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi;

export function redactHarnessTelemetryText(value: string): string {
  return value
    .replace(URL_USERINFO_RE, "$1[REDACTED_CREDENTIALS]@")
    .replace(HARNESS_EMAIL_RE, "[REDACTED_EMAIL]")
    .replace(HARNESS_CN_MOBILE_RE, "[REDACTED_PHONE]")
    .replace(HARNESS_FORMATTED_PHONE_RE, (candidate) => {
      const digits = candidate.replace(/\D/g, "");
      return digits.length >= 8 && digits.length <= 15
        ? "[REDACTED_PHONE]"
        : candidate;
    });
}

/** Entries / keys one container contributes to a redacted payload. */
const BREADTH_LIMIT = 100;
/** Marker element appended to a cut array. Reports the PRE-cut length. */
const truncatedItemsMarker = (kept: number, total: number): string =>
  `[REDACTED_TRUNCATED_ITEMS: kept ${kept} of ${total}]`;
/** Marker KEY added to a cut object. Bracketed so it cannot collide with a
 *  real telemetry field name. */
const TRUNCATED_KEYS_MARKER = "[REDACTED_TRUNCATED_KEYS]";

/**
 * Every Factory-originated Session event crosses this boundary before durable
 * storage. Secret-shaped fields/values use the Factory's canonical scanner;
 * common contact PII is removed as a second pass. Environment-reference names
 * (for example `GOHIRE_API_KEY`) remain visible, while their values never do.
 *
 * Bounded, and every bound SAYS SO. Depth already did (`[REDACTED_DEPTH]`);
 * breadth used to drop an array's 101st entry onward — and an object's 101st
 * key onward — with no marker and no count, so a truncated payload was
 * indistinguishable from a complete one at every later read. Both cuts now
 * carry the real pre-cut size, the same discipline the depth marker follows.
 */
export function redactHarnessTelemetryPayload(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const secretFree = sanitizeSensitiveInput(payload, "harness.telemetry")
    .sanitized;
  const seen = new WeakSet<object>();
  const visit = (value: unknown, key = "", depth = 0): unknown => {
    if (depth > 16) return "[REDACTED_DEPTH]";
    if (typeof value === "string") {
      if (HARNESS_PII_KEY_RE.test(key)) return "[REDACTED_PII]";
      return redactHarnessTelemetryText(value);
    }
    if (value === null || value === undefined || typeof value !== "object") {
      return value;
    }
    if (seen.has(value)) return "[REDACTED_CIRCULAR]";
    seen.add(value);
    let redacted: unknown;
    if (Array.isArray(value)) {
      const kept: unknown[] = value
        .slice(0, BREADTH_LIMIT)
        .map((entry) => visit(entry, "", depth + 1));
      if (value.length > BREADTH_LIMIT) {
        kept.push(truncatedItemsMarker(kept.length, value.length));
      }
      redacted = kept;
    } else {
      const entries = Object.entries(value as Record<string, unknown>);
      const kept: Array<[string, unknown]> = entries
        .slice(0, BREADTH_LIMIT)
        .map(([childKey, entry]) => [
          childKey,
          HARNESS_PII_KEY_RE.test(childKey)
            ? "[REDACTED_PII]"
            : visit(entry, childKey, depth + 1),
        ]);
      if (entries.length > BREADTH_LIMIT) {
        kept.push([
          TRUNCATED_KEYS_MARKER,
          `kept ${kept.length} of ${entries.length}`,
        ]);
      }
      redacted = Object.fromEntries(kept);
    }
    seen.delete(value);
    return redacted;
  };
  const result = visit(secretFree);
  return result && typeof result === "object" && !Array.isArray(result)
    ? (result as Record<string, unknown>)
    : {};
}
