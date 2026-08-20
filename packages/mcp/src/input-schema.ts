/**
 * Trust boundary for the argument contract an MCP server advertises.
 *
 * `tools/list` returns one JSON Schema per tool (`inputSchema`). That schema is
 * the ONLY description of a tool's arguments the model ever sees, so it has to
 * survive the shim boundary — but it arrives from a remote, unreviewed server
 * and cannot be trusted verbatim.
 *
 * This module decides one thing: is this a usable object-argument contract? It
 * either returns a canonical, detached JSON copy of the server's schema, or it
 * returns a reason and NO schema. It never invents a permissive stand-in: a
 * fabricated `{ additionalProperties: true }` reads downstream as "the server
 * declared that anything goes", which is exactly the contentless contract that
 * makes models hallucinate arguments. Absent is honest; fake is not.
 */

export type McpInputSchemaDecision =
  | { readonly usable: true; readonly schema: Record<string, unknown> }
  | { readonly usable: false; readonly reason: string };

/** Rejection reasons are surfaced on `McpServerStatus` (→ /health), so they
 *  stay short and structural. Never echo schema payload into them. */
const MAX_REASON_CHARS = 200;
const MAX_VALUE_PREVIEW_CHARS = 32;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonTypeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

/** Structural preview only — a type name, or a short quoted string literal. */
function preview(value: unknown): string {
  if (typeof value === "string") {
    return JSON.stringify(value.slice(0, MAX_VALUE_PREVIEW_CHARS));
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return jsonTypeOf(value);
}

function reject(reason: string): McpInputSchemaDecision {
  return { usable: false, reason: reason.slice(0, MAX_REASON_CHARS) };
}

/**
 * Validate a server-advertised `inputSchema` and return the exact schema to
 * publish on the tool descriptor.
 *
 * Checks are limited to the top level — the part that decides whether this is
 * an object-argument contract at all, and the part every model provider's
 * tool-definition format requires. Everything nested is passed through
 * verbatim: a per-keyword JSON Schema validator here would reject legitimate
 * schemas (`$ref`, vendor keywords, drafts we don't know) and throwing away a
 * good contract puts us straight back to the hallucinated-argument bug.
 *
 * Deliberately NOT a check: schema size. Size is a prompt-budget policy for
 * whoever builds the model roster, not a statement about contract validity, and
 * silently dropping a large-but-real contract would be the worse failure.
 */
export function sanitizeMcpInputSchema(raw: unknown): McpInputSchemaDecision {
  if (raw === undefined || raw === null) {
    return reject("no inputSchema advertised");
  }
  if (!isPlainObject(raw)) {
    return reject(`inputSchema must be an object, got ${jsonTypeOf(raw)}`);
  }

  const declaredType = raw.type;
  if (declaredType !== undefined && declaredType !== "object") {
    return reject(
      `inputSchema.type must be "object", got ${preview(declaredType)}`,
    );
  }
  if (declaredType === undefined && !isPlainObject(raw.properties)) {
    return reject(
      'inputSchema declares neither type "object" nor a properties map',
    );
  }

  if (raw.properties !== undefined) {
    if (!isPlainObject(raw.properties)) {
      return reject(
        `inputSchema.properties must be an object, got ${jsonTypeOf(raw.properties)}`,
      );
    }
    for (const [field, fieldSchema] of Object.entries(raw.properties)) {
      // A non-object property value is not a schema. Dropping just that field
      // would quietly rewrite the server's contract (a required argument could
      // vanish), so the whole schema is refused instead.
      if (!isPlainObject(fieldSchema)) {
        return reject(
          `inputSchema.properties.${field} is not a schema object (${jsonTypeOf(fieldSchema)})`,
        );
      }
    }
  }

  if (raw.required !== undefined) {
    if (
      !Array.isArray(raw.required) ||
      raw.required.some((field) => typeof field !== "string")
    ) {
      return reject("inputSchema.required must be an array of property names");
    }
  }

  // Round-trip through JSON: proves the value really is the plain JSON document
  // it arrived as (rejects cycles/BigInt/`toJSON` surprises) and detaches it
  // from the SDK-owned object so a downstream consumer can't mutate live
  // connection state.
  let canonical: unknown;
  try {
    canonical = JSON.parse(JSON.stringify(raw));
  } catch {
    return reject("inputSchema is not JSON-serializable");
  }
  if (!isPlainObject(canonical)) {
    return reject("inputSchema is not JSON-serializable");
  }

  // The ONLY normalization performed. A properties map without `type` is valid
  // JSON Schema, but provider tool-definition formats require `type:"object"`
  // at the root — omitting it would fail the provider call instead of informing
  // the model. Nothing else is added, removed or rewritten.
  if (canonical.type === undefined) canonical.type = "object";

  return { usable: true, schema: canonical };
}
