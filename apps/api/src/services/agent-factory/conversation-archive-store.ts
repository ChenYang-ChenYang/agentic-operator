// #CONV-ARCHIVE — FS NDJSON store for compaction-dropped conversation turns.
//
// One append-only NDJSON file per (tenant, domain, conversation). Append is atomic-enough for the
// single-writer conductor (one brain run per conversation at a time); a torn final line from a
// crash mid-append is skipped on read, never fatal. Search/count re-read the file — conversations
// are bounded (tens of folds × ≤40 msgs), so a full read stays cheap; the shared pure matcher in
// @agentic/agent-factory keeps store behavior identical to what the brain tool documents.

import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import {
  bindOntologyInquiryArchive,
  searchArchiveEntries,
  type ConversationArchiveEntry,
  type ConversationArchiveSearchHit,
  type FactoryConversationArchive,
  type OntologyInquiryArchive,
} from "@agentic/agent-factory";
import { resolveDataRootPath } from "../../config/data-paths";

// The repo-wide resolution (env → workspace root → cwd), NOT a bare `./data`:
// this store is reached from workers and tests that never ran the api's
// bootstrap, where `./data` resolves against an arbitrary cwd and strands
// archives outside the documented data root. Session purge resolves the same
// way, from the same function — a read side and a delete side that disagree
// about the root is how "deleted sessions stay recallable" comes back.
function dataRoot(): string {
  return resolveDataRootPath();
}

function safeSegment(value: string): string {
  const cleaned = value.replace(/[^a-zA-Z0-9._-]/g, "_");
  return cleaned.slice(0, 200) || "_";
}

export class FsConversationArchiveStore implements FactoryConversationArchive {
  constructor(
    private readonly tenantId: string,
    private readonly domain: string,
  ) {}

  private dir(): string {
    return path.join(
      dataRoot(),
      "factory-conversation-archive",
      "_tenants",
      safeSegment(this.tenantId),
      safeSegment(this.domain),
    );
  }

  private file(conversationId: string): string {
    return path.join(this.dir(), `${safeSegment(conversationId)}.ndjson`);
  }

  async append(conversationId: string, entries: ConversationArchiveEntry[]): Promise<void> {
    if (!entries.length) return;
    await mkdir(this.dir(), { recursive: true });
    const lines = entries.map((entry) => `${JSON.stringify(entry)}\n`).join("");
    await appendFile(this.file(conversationId), lines, "utf8");
  }

  private async readAll(conversationId: string): Promise<ConversationArchiveEntry[]> {
    let raw: string;
    try {
      raw = await readFile(this.file(conversationId), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const out: ConversationArchiveEntry[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as ConversationArchiveEntry);
      } catch {
        /* torn final line from a crash mid-append — skip, never fatal */
      }
    }
    return out;
  }

  async search(
    conversationId: string,
    query: string,
    opts?: { limit?: number },
  ): Promise<ConversationArchiveSearchHit[]> {
    const entries = await this.readAll(conversationId);
    return searchArchiveEntries(entries, query, Math.max(1, Math.min(50, opts?.limit ?? 6)));
  }

  async count(conversationId: string): Promise<number> {
    return (await this.readAll(conversationId)).length;
  }
}

// ── the ONE archive-id contract, shared with session purge ───────────────────
//
// An archive is keyword-searchable forever, so an archive that Session deletion
// cannot COLLECT is a privacy defect, not a housekeeping one: the user believes
// the session is gone and `recall_*` still finds its content. Deletion maps
// files back to a session through the job id embedded in the FILE NAME
// (`ontocode-session-purge.ts` imports the matcher below), so minting and
// collecting must be one contract that cannot drift.
//
// Consequence: an id that would not be collected is NOT minted. The caller then
// gets no archive at all, and the inquiry loop degrades exactly as it does with
// no archive configured (it refuses to fold) — never "folded, retained
// forever, unreachable by delete".

/** `ocf-<jobId>-a<attempt>`, the shape session purge collects. */
const PURGE_COLLECTABLE_ID_RE = /^ocf-(ocj-[A-Za-z0-9]+)-a\d+$/;

/**
 * Mint the archive conversation id for one harness job attempt, or `null` when
 * the inputs cannot produce a collectable name.
 *
 * SERVER-DERIVED BY CONSTRUCTION: both inputs come from the claimed harness job
 * row. Nothing a model emits reaches this function, and the returned id is the
 * only thing that selects which archive is read or written.
 */
export function factoryConversationArchiveId(
  jobId: string | undefined | null,
  attempt: number | undefined | null,
): string | null {
  const id = (jobId ?? "").trim();
  if (!id) return null;
  if (!Number.isInteger(attempt) || (attempt as number) < 1) return null;
  const candidate = `ocf-${id}-a${attempt}`;
  return PURGE_COLLECTABLE_ID_RE.test(candidate) ? candidate : null;
}

/** `ocf-<jobId>-a<attempt>.ndjson` → jobId; `null` when the name is not one of
 * ours. The single matcher both the archive store and session purge use. */
export function jobIdOfPurgeCollectableFile(fileName: string): string | null {
  if (!fileName.endsWith(".ndjson")) return null;
  return (
    PURGE_COLLECTABLE_ID_RE.exec(fileName.slice(0, -".ndjson".length))?.[1] ??
    null
  );
}

/**
 * The conversation-bound archive port for ONE ontology-analysis job attempt.
 *
 * `undefined` whenever the identity needed for a collectable, tenant-scoped
 * archive is missing — the analysis then runs with no retention rather than
 * with retention nobody can delete.
 */
export function makeOntoCodeInquiryArchive(identity: {
  tenantId?: string | null;
  domainId?: string | null;
  jobId?: string | null;
  attempt?: number | null;
}): OntologyInquiryArchive | undefined {
  const tenantId = (identity.tenantId ?? "").trim();
  const domainId = (identity.domainId ?? "").trim();
  if (!tenantId || !domainId) return undefined;
  const conversationId = factoryConversationArchiveId(
    identity.jobId,
    identity.attempt,
  );
  if (!conversationId) return undefined;
  return bindOntologyInquiryArchive(
    new FsConversationArchiveStore(tenantId, domainId),
    conversationId,
  );
}
