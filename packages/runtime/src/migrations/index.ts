/**
 * Workflow manifest migrations.
 *
 * When a breaking schema change ships (rename, enum removal, key deletion),
 * register a migration here that upgrades manifests from version `N` to
 * version `N+1`. `migrate()` chains them so a v1 file is auto-upgraded to
 * `CURRENT_SCHEMA_VERSION` at boot, BEFORE `WorkflowManifestSchema.parse`.
 *
 * Why boot-time, not on-disk-rewrite (per CLAUDE.md §Inngest durability):
 *   - Migrations execute before Inngest function registration in
 *     `bootstrapTenant`, so by the time runs replay, the in-memory
 *     manifest is already canonical.
 *   - `agent_versions.manifest_json` stores the migrated snapshot, so
 *     replays use that — never the on-disk file.
 *   - Hand-editing the on-disk file post-deployment never affects
 *     in-flight runs (they're pinned to the snapshot).
 *
 * To add a migration:
 *   1. Bump `CURRENT_SCHEMA_VERSION` below.
 *   2. Add a `MigrationStep` to `MIGRATIONS` that rewrites raw JSON from
 *      `fromVersion` → `fromVersion + 1`.
 *   3. Write a fixture pair under
 *      `apps/api/test/migrations/<from>-to-<to>/{before,expected_after}.json`
 *      and add a test case (TC-34 reserves that slot).
 *
 * Wire format: a manifest file MAY carry `$schemaVersion: <number>` as the
 * first array element wrapped in an object, OR remain a bare array (treated
 * as v1). Always emit `$schemaVersion` after the first save through the editor.
 */

import { assertExecutableWorkflowManifestSource } from "@agentic/contracts";

export const CURRENT_SCHEMA_VERSION = 2;

export interface MigrationStep {
  fromVersion: number;
  toVersion: number;
  description: string;
  /** Rewrites raw JSON. Must be deterministic and idempotent. */
  apply(input: unknown): unknown;
}

/**
 * Migrations are applied in order. Each step's `toVersion` must equal the
 * next step's `fromVersion`. The chain must cover [1, CURRENT_SCHEMA_VERSION].
 *
 * The v1→v2 step is intentionally identity-only: v2 adds an envelope and
 * additive agent fields, while the shared compatibility parser supplies
 * defaults after migration.
 */
export const MIGRATIONS: ReadonlyArray<MigrationStep> = [
  {
    fromVersion: 1,
    toVersion: 2,
    description:
      "Adopt the additive v2 agent-definition envelope without rewriting legacy agents",
    // V2 is additive. The shared compatibility schema supplies typed v2
    // defaults after this boundary, so legacy bare arrays need no destructive
    // field rewrite here.
    apply: (input) => input,
  },
];

/**
 * Read the `$schemaVersion` from a raw manifest, or default to 1.
 *
 * Accepted shapes:
 *   - bare array `[{...}, {...}]`                       → v1
 *   - `{ $schemaVersion: N, agents: [...] }`            → vN
 *
 * Both shapes flow through to `WorkflowManifestSchema.parse`, which expects
 * the bare array; the unwrap is done in `migrate()` below.
 */
export function detectSchemaVersion(input: unknown): number {
  if (Array.isArray(input)) return 1;
  if (
    input &&
    typeof input === "object" &&
    "$schemaVersion" in input &&
    typeof (input as { $schemaVersion: unknown }).$schemaVersion === "number"
  ) {
    return (input as { $schemaVersion: number }).$schemaVersion;
  }
  return 1;
}

/**
 * Return the bare-array manifest payload regardless of wrapper.
 */
function unwrapManifest(input: unknown): unknown {
  if (Array.isArray(input)) return input;
  if (input && typeof input === "object" && "agents" in input) {
    return (input as { agents: unknown }).agents;
  }
  return input;
}

/**
 * Run all migrations needed to bring `input` from its declared
 * `$schemaVersion` up to `CURRENT_SCHEMA_VERSION`. Returns the bare-array
 * manifest payload ready for `WorkflowManifestSchema.parse`.
 *
 * Throws if a gap exists in the migration chain (eg the file declares v3
 * but we only know how to migrate v1→v2).
 */
export function migrate(input: unknown): {
  fromVersion: number;
  toVersion: number;
  payload: unknown;
  applied: ReadonlyArray<string>;
} {
  assertExecutableWorkflowManifestSource(input);
  const fromVersion = detectSchemaVersion(input);
  let payload = unwrapManifest(input);
  const applied: string[] = [];

  if (fromVersion === CURRENT_SCHEMA_VERSION) {
    return {
      fromVersion,
      toVersion: CURRENT_SCHEMA_VERSION,
      payload,
      applied,
    };
  }

  if (fromVersion > CURRENT_SCHEMA_VERSION) {
    throw new Error(
      `[migrate] manifest declares $schemaVersion=${fromVersion} but runtime only knows up to v${CURRENT_SCHEMA_VERSION}. Upgrade the runtime.`,
    );
  }

  let current = fromVersion;
  while (current < CURRENT_SCHEMA_VERSION) {
    const step = MIGRATIONS.find((m) => m.fromVersion === current);
    if (!step) {
      throw new Error(
        `[migrate] no migration registered for v${current} → v${current + 1}. The chain in packages/runtime/src/migrations/index.ts is broken.`,
      );
    }
    payload = step.apply(payload);
    applied.push(`${step.fromVersion}->${step.toVersion}: ${step.description}`);
    current = step.toVersion;
  }

  return { fromVersion, toVersion: CURRENT_SCHEMA_VERSION, payload, applied };
}
