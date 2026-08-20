/**
 * #ASSISTANT-CITE (render half) — turn the citations the server already
 * enforces into something an FDE can open.
 *
 * The planner rejects an answer whose `citedRefs` were not supplied by that
 * turn's compiled context or a tool result, and persists the surviving refs on
 * the message. Nothing rendered them, so an FDE reading "以下是基于本体事实的
 * 分类" had no way to check which artifact the claim stood on — while the
 * system prompt promised the model the workspace would resolve them into
 * links.
 *
 * Parsing is deliberately strict: a ref we cannot resolve is dropped rather
 * than rendered as a dead link, because a citation that does not open is worse
 * than no citation — it looks like evidence and isn't.
 */

export interface AssistantCitation {
  /** The exact persisted string, kept so the audit text stays quotable. */
  raw: string;
  artifactId: string;
  versionId: string;
}

const CITATION_SCHEMA = "ontocode-assistant-citations/v1";
/** `artifact:<artifactId>@<versionId>` — the only form the server mints. */
const ARTIFACT_REF = /^artifact:(oca-[a-z0-9]+)@(ocav-[a-z0-9]+)$/;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function parseAssistantCitations(
  content: unknown,
): AssistantCitation[] {
  const record = asRecord(content);
  if (!record) return [];
  if (record.citationSchema !== CITATION_SCHEMA) return [];
  const refs = Array.isArray(record.citedRefs) ? record.citedRefs : [];
  const out: AssistantCitation[] = [];
  for (const entry of refs) {
    if (typeof entry !== "string") continue;
    const match = ARTIFACT_REF.exec(entry.trim());
    // `ontology:<hash>#tool(subject)` refs are minted by the read-tool loop and
    // have no artifact to open yet; dropping them keeps every rendered chip
    // clickable instead of mixing openable and inert ones.
    if (!match) continue;
    out.push({
      raw: entry.trim(),
      artifactId: match[1]!,
      versionId: match[2]!,
    });
  }
  return out;
}
