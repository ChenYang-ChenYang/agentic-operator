/**
 * Typed Ontology transport failures — the evidence an HTTP route needs in
 * order to answer honestly.
 *
 * Every Ontology source used to fail with a plain `Error` whose only signal was
 * its message. A caller that wanted to distinguish "this domain does not exist"
 * from "the ontology service is down" from "the ontology service rejected our
 * credential" had exactly two options: sniff English substrings, or flatten
 * every cause into one status. Both are how a 404 ends up being reported for an
 * outage.
 *
 * So the failure REASON is carried as data. The message text is unchanged from
 * what each throw site already wrote — this module adds structure beside the
 * prose, it does not replace it, and it never invents a reason the transport
 * did not actually observe.
 *
 * `findOntologyTransportError` walks the `cause` chain, because the strict
 * sources deliberately re-wrap a low-level failure in a domain-level sentence.
 * Wrapping must keep the original reason reachable; discarding it is the same
 * evidence loss in a different place.
 */

export type OntologyTransportFailure =
  /** No base URL / no transport is configured at all. */
  | "unconfigured"
  /** The connection could not be established (DNS, refused, reset). */
  | "unreachable"
  /** The request was aborted by this client's own read deadline. */
  | "timeout"
  /** The service answered, with a non-success status. */
  | "rejected"
  /** The service answered, with a body that violates the read contract. */
  | "payload_contract"
  /** The catalog does not carry the requested domain identity. */
  | "domain_not_in_catalog"
  /** The domain exists but carries nothing executable to read. */
  | "domain_empty"
  /** The graph changed mid-read, so no single version could be assembled. */
  | "domain_unstable"
  /** A pinned uploaded bundle is missing for this tenant. */
  | "uploaded_bundle_missing"
  /**
   * NO transport-level reason was observed. A read that re-wraps a failure it
   * did not classify says this, and only this. The alternative — picking the
   * "nearest plausible" transport reason — is how a defect in our own
   * normalizers gets reported as "the ontology service returned content that
   * violates the read contract", which sends an FDE to audit data that was
   * never at fault. Unknown is a reason; a borrowed one is not.
   */
  | "internal";

export type OntologyTransportKind = "allmeta" | "upload";

export interface OntologyTransportErrorInit {
  failure: OntologyTransportFailure;
  transport: OntologyTransportKind;
  /** The domain identity the failing read was asking for, when known. */
  domainId?: string;
  /** Present only for `rejected` — the status the service actually returned. */
  upstreamStatus?: number;
  cause?: unknown;
}

export class OntologyTransportError extends Error {
  readonly failure: OntologyTransportFailure;
  readonly transport: OntologyTransportKind;
  readonly domainId?: string;
  readonly upstreamStatus?: number;

  constructor(message: string, init: OntologyTransportErrorInit) {
    super(
      message,
      init.cause !== undefined ? { cause: init.cause } : undefined,
    );
    this.name = "OntologyTransportError";
    this.failure = init.failure;
    this.transport = init.transport;
    if (init.domainId !== undefined) this.domainId = init.domainId;
    if (init.upstreamStatus !== undefined)
      this.upstreamStatus = init.upstreamStatus;
  }
}

/** The nearest typed transport failure in an error's `cause` chain, or null
 *  when nothing on the chain observed a transport-level reason. Bounded so a
 *  self-referential cause cannot spin. */
export function findOntologyTransportError(
  error: unknown,
  depth = 0,
): OntologyTransportError | null {
  if (depth > 8) return null;
  if (error instanceof OntologyTransportError) return error;
  const cause = (error as { cause?: unknown } | null | undefined)?.cause;
  if (cause === undefined || cause === null) return null;
  return findOntologyTransportError(cause, depth + 1);
}

/** Classify a rejected `fetch` without guessing: the abort flag is this
 *  client's own deadline, everything else is a failure to connect. */
export function classifyFetchRejection(
  error: unknown,
  timedOut: boolean,
): "timeout" | "unreachable" {
  if (timedOut) return "timeout";
  return (error as { name?: unknown })?.name === "AbortError"
    ? "timeout"
    : "unreachable";
}
