/**
 * Reads a tool-call evidence artifact and says, in business terms, what it did
 * to the system of record (§G4, ask 3).
 *
 * The artifact is the exact receipt the runtime wrote: `input.operation` plus
 * `input.payload` is what the agent asked for, `output` is what came back, and
 * `dispatch.sandbox_decision` records whether the call reached the live system
 * or a sandbox. Read and write are decidable from the output shape alone —
 * a query answers `{rows: [...]}`, a mutation answers `{ok, id, row}` — so no
 * per-tool catalogue has to be maintained alongside the tools.
 *
 * There is deliberately no before/after diff here. The runtime records only the
 * post-state, so a "was → now" rendering would have to invent the left-hand
 * side. Showing the created document and its fields is the honest maximum.
 */

export interface EvidenceArtifact {
  name?: string;
  input?: { operation?: string; payload?: Record<string, unknown> } | null;
  output?: unknown;
  is_error?: boolean;
  duration_ms?: number;
  dispatch?: { sandbox_decision?: string } | null;
  actor?: { agent?: string; step?: string } | null;
}

export interface DataChange {
  kind: "write" | "read" | "error" | "unknown";
  /** e.g. "createTransferOrder" — the ERP operation actually invoked. */
  operation: string | null;
  /** Business document id the write produced, when there is one. */
  documentId: string | null;
  /** Field/value pairs worth showing: the written row, or the query filter. */
  fields: Array<{ key: string; value: string }>;
  /** Row count for a read. */
  rowCount: number | null;
  /** True when the call reached the real system rather than a sandbox. */
  live: boolean;
  errorText: string | null;
}

/** Values render as one short line; anything structural is summarised. */
function renderValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string") return value.length ? value : "—";
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.length}]`;
  return "{…}";
}

/**
 * Field order follows the row's own key order — the ERP returns business
 * columns in a meaningful order and re-sorting them alphabetically would put
 * STATUS above the document id.
 */
function fieldsFrom(
  row: Record<string, unknown>,
  limit: number,
): Array<{ key: string; value: string }> {
  return Object.entries(row)
    .filter(([, v]) => v !== null && v !== undefined && v !== "")
    .slice(0, limit)
    .map(([key, value]) => ({ key, value: renderValue(value) }));
}

const MAX_FIELDS = 8;

export function readDataChange(
  artifact: EvidenceArtifact | null | undefined,
): DataChange | null {
  if (!artifact || typeof artifact !== "object") return null;

  const operation =
    typeof artifact.input?.operation === "string"
      ? artifact.input.operation
      : (artifact.name ?? null);
  const live = artifact.dispatch?.sandbox_decision === "live";
  const output = artifact.output;

  if (artifact.is_error === true) {
    return {
      kind: "error",
      operation,
      documentId: null,
      fields: [],
      rowCount: null,
      live,
      errorText:
        typeof output === "string"
          ? output
          : typeof (output as { error?: unknown })?.error === "string"
            ? ((output as { error: string }).error)
            : null,
    };
  }

  if (output && typeof output === "object") {
    const o = output as Record<string, unknown>;

    // Mutation receipt: {ok, id, row}
    if (o.ok === true || typeof o.id === "string") {
      const row =
        o.row && typeof o.row === "object"
          ? (o.row as Record<string, unknown>)
          : {};
      return {
        kind: "write",
        operation,
        documentId: typeof o.id === "string" ? o.id : null,
        fields: fieldsFrom(row, MAX_FIELDS),
        rowCount: null,
        live,
        errorText: null,
      };
    }

    // Query result: {rows: [...]}
    if (Array.isArray(o.rows)) {
      const first =
        o.rows[0] && typeof o.rows[0] === "object"
          ? (o.rows[0] as Record<string, unknown>)
          : null;
      return {
        kind: "read",
        operation,
        documentId: null,
        // Preview the first row so a query is not just an opaque count.
        fields: first ? fieldsFrom(first, MAX_FIELDS) : [],
        rowCount: o.rows.length,
        live,
        errorText: null,
      };
    }
  }

  // Shape we do not recognise: show the request rather than nothing, so the
  // row still says which operation ran against which key.
  const payload = artifact.input?.payload;
  return {
    kind: "unknown",
    operation,
    documentId: null,
    fields:
      payload && typeof payload === "object"
        ? fieldsFrom(payload as Record<string, unknown>, MAX_FIELDS)
        : [],
    rowCount: null,
    live,
    errorText: null,
  };
}
