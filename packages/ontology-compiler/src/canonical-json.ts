/**
 * Deterministic JSON serialization: recursively sorted object keys, 2-space
 * indent, trailing newline, no timestamps added. Byte-stable for identical
 * input so `workflow_versions.version = auto-<sha256>` stays meaningful
 * across recompiles (design G1 item 4).
 */

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      const entry = record[key];
      if (entry === undefined) continue;
      out[key] = sortValue(entry);
    }
    return out;
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return `${JSON.stringify(sortValue(value), null, 2)}\n`;
}
