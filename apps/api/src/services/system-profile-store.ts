/**
 * System-profile store — CRUD for the `system_profiles` table (OntoCode
 * 外部系统档案). One row per (tenant, external platform); the payload is the
 * @agentic/contracts `SystemProfileV1` document, validated on every write and
 * re-validated on read (malformed rows are skipped, never crash a list).
 *
 * Profiles are the single authority for system-name aliases. Consumers:
 *   · /v1/system-profiles routes (Settings/OntoCode surfaces)
 *   · the factory brain's integration binding (alias groups + human boundaries)
 */

import { and, eq } from "drizzle-orm";
import { getDb, systemProfiles } from "@agentic/db";
import { makeId } from "@agentic/shared";
import {
  SystemProfileV1Schema,
  systemAliasGroups,
  type SystemProfileV1,
} from "@agentic/contracts";

export function listSystemProfiles(tenantId: string): SystemProfileV1[] {
  const db = getDb();
  const rows = db
    .select()
    .from(systemProfiles)
    .where(eq(systemProfiles.tenantId, tenantId))
    .all();
  const parsed: SystemProfileV1[] = [];
  for (const row of rows) {
    try {
      parsed.push(SystemProfileV1Schema.parse(JSON.parse(row.profileJson)));
    } catch {
      // A malformed row must not take down every consumer of the list.
      console.warn(
        `[system-profiles] skipping malformed profile row ${row.id}`,
      );
    }
  }
  return parsed.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Upsert a profile. A2 — going through this function IS the human-review commit
 * (drafts never land here; only the reviewed PUT does), so the server stamps the
 * confirmation (`provenance.confirmedBy` + `confirmedAt`) itself. `mode` keeps
 * recording where the draft came from (ai-drafted / imported / manual); the
 * stamp is the separate, verifiable proof that a person reviewed it. Callers pass
 * the authenticated reviewer via `opts.confirmedBy`.
 */
/** A2 — pure: overlay the human-review confirmation stamp onto a parsed profile.
 * `mode` is preserved (draft origin); the stamp is the separate proof of review.
 * NOTE: `confirmedAt` records the LAST confirmation (re-stamped on every PUT, since
 * each PUT is itself a review commit); first-insert time lives in the row's
 * createdAt. When `confirmedBy` is absent the previous identity is kept while time
 * advances — safe on the PUT route (auth identity is always present); a direct
 * caller passing undefined would decouple who/when. */
export function stampConfirmation(
  profile: SystemProfileV1,
  confirmedBy: string | undefined,
  confirmedAt: number,
): SystemProfileV1 {
  return {
    ...profile,
    provenance: {
      ...profile.provenance,
      ...(confirmedBy ? { confirmedBy } : {}),
      confirmedAt,
    },
  };
}

export function upsertSystemProfile(
  tenantId: string,
  input: unknown,
  opts?: { confirmedBy?: string },
): SystemProfileV1 {
  const parsed = SystemProfileV1Schema.parse(input);
  // lastProbe is server-authored evidence. A reviewed profile PUT may never
  // import or preserve a client-supplied verdict; every profile revision must
  // be probed again through recordSystemProbe().
  const withoutProbe = { ...parsed };
  delete withoutProbe.lastProbe;
  const profile = stampConfirmation(
    SystemProfileV1Schema.parse(withoutProbe),
    opts?.confirmedBy,
    Date.now(),
  );
  const db = getDb();
  const nowMs = new Date();
  const existing = db
    .select({ id: systemProfiles.id })
    .from(systemProfiles)
    .where(
      and(
        eq(systemProfiles.tenantId, tenantId),
        eq(systemProfiles.profileId, profile.id),
      ),
    )
    .get();
  if (existing) {
    db.update(systemProfiles)
      .set({ profileJson: JSON.stringify(profile), updatedAt: nowMs })
      .where(eq(systemProfiles.id, existing.id))
      .run();
  } else {
    db.insert(systemProfiles)
      .values({
        id: makeId("spf"),
        tenantId,
        profileId: profile.id,
        profileJson: JSON.stringify(profile),
        createdAt: nowMs,
        updatedAt: nowMs,
      })
      .run();
  }
  return profile;
}

/** Write a connection-probe result onto a profile WITHOUT touching provenance —
 * a probe is a system action, not a human review, so it must never masquerade
 * as a confirmation stamp (that's why it doesn't go through upsertSystemProfile). */
export function recordSystemProbe(
  tenantId: string,
  profileId: string,
  probe: { ok: boolean; at: number; provider?: string; detail?: string },
): SystemProfileV1 | null {
  const db = getDb();
  const row = db
    .select()
    .from(systemProfiles)
    .where(
      and(
        eq(systemProfiles.tenantId, tenantId),
        eq(systemProfiles.profileId, profileId),
      ),
    )
    .get();
  if (!row) return null;
  let profile: SystemProfileV1;
  try {
    profile = SystemProfileV1Schema.parse(JSON.parse(row.profileJson));
  } catch {
    return null;
  }
  const updated: SystemProfileV1 = {
    ...profile,
    lastProbe: {
      ok: probe.ok,
      at: probe.at,
      ...(probe.provider ? { provider: probe.provider } : {}),
      ...(probe.detail ? { detail: probe.detail } : {}),
    },
  };
  db.update(systemProfiles)
    .set({ profileJson: JSON.stringify(updated), updatedAt: new Date() })
    .where(eq(systemProfiles.id, row.id))
    .run();
  return updated;
}

export function deleteSystemProfile(
  tenantId: string,
  profileId: string,
): boolean {
  const db = getDb();
  const result = db
    .delete(systemProfiles)
    .where(
      and(
        eq(systemProfiles.tenantId, tenantId),
        eq(systemProfiles.profileId, profileId),
      ),
    )
    .run();
  return result.changes > 0;
}

/** Alias groups for the binding engine — one group per confirmed profile. */
export function tenantSystemAliasGroups(tenantId: string): string[][] {
  return systemAliasGroups(listSystemProfiles(tenantId));
}

/** Systems the tenant explicitly governs as deliberate human boundaries.
 * Two ways in: an explicit governance decision, OR a PLANNED system (ontology
 * references it, platform not built yet) whose chosen fallback is
 * human_boundary — until it's built, a person does that step. Planned systems
 * with fallback "block" are NOT boundaries; they stay in the deploy-readiness
 * pending list instead. */
export function tenantHumanBoundarySystems(tenantId: string): string[] {
  return listSystemProfiles(tenantId)
    .filter(
      (profile) =>
        profile.governance?.humanBoundary === true ||
        (profile.availability === "planned" &&
          profile.plannedFallback === "human_boundary"),
    )
    .flatMap((profile) => [profile.id, profile.name, ...profile.aliases]);
}
