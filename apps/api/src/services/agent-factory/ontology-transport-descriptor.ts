// Which CONCRETE transport is behind an OntologySource, answered by the source
// object itself.
//
// The returned `DomainOntology.source` cannot answer this: it is only
// `"allmeta" | "snapshot"`, an uploaded bundle reports neither, and a composite
// routes per domain. Reading env (`ALLMETA_BASE_URL`) instead would be a guess
// about configuration rather than a measurement of what answered. So each
// source describes itself, and a source that cannot say so returns nothing —
// "we do not know" is a legitimate answer and must not be dressed up as a
// specific transport.

export type OntologyTransportKind = "allmeta" | "manifest";

export interface OntologyTransportDescriptor {
  kind: OntologyTransportKind;
  /**
   * Measured: this transport is configured/present and would actually attempt
   * to answer for the domain it was asked about. An unconfigured Allmeta (no
   * base URL) or a manifest with no matching local folder is NOT something an
   * upload can be said to shadow.
   */
  configured: boolean;
}

export interface DescribesOntologyTransport {
  describeTransport(
    domainId: string,
  ): Promise<OntologyTransportDescriptor | null>;
}

export function describesOntologyTransport(
  source: unknown,
): source is DescribesOntologyTransport {
  return (
    !!source &&
    typeof (source as DescribesOntologyTransport).describeTransport ===
      "function"
  );
}

/** Ask a source what it is, or report that it could not say. Never guesses. */
export async function describeOntologyTransport(
  source: unknown,
  domainId: string,
): Promise<OntologyTransportDescriptor | null> {
  if (!describesOntologyTransport(source)) return null;
  return (await source.describeTransport(domainId)) ?? null;
}
