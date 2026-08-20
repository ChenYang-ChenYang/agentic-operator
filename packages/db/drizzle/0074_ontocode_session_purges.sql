-- #SESSION-PURGE — the durable record of a deleted OntoCode Session.
--
-- Why a table and not just an audit line. A Session's durable footprint spans
-- four stores and only one of them is reachable by a row delete:
--   1. SQLite rows            — cascade, already works
--   2. data/logs/factory-runs/<tenantId>/ocf-<jobId>-a<n>.ndjson  (brain transcript)
--   3. data/factory-conversation-archive/_tenants/<tenantId>/<domain>/<runId>.ndjson
--      (recall_conversation searches this — a "deleted" Session stays recallable)
--   4. data/factory-drafts/_tenants/<tenantId>/<domain>/versions/... (generated code)
--   plus ontocode_artifact_blobs rows, whose `content_text` holds the artifact
--   body verbatim and which carry no session FK.
--
-- The structural trap: every one of those files is named by JOB id, and the job
-- rows are the ONLY thing that maps a file back to a Session. The cascade
-- deletes those rows first — so anything not collected BEFORE the delete becomes
-- permanently unattributable garbage. Deletion therefore has to be:
--   collect (rows still present) → record → delete rows → purge files → settle.
--
-- This table is that record. It survives the Session so a partial purge can be
-- finished later instead of silently leaving orphans, and so "what was removed"
-- is answerable after the fact. It deliberately carries NO foreign key to the
-- session: the whole point is that the session row is gone.
CREATE TABLE `ontocode_session_purges` (
  `id` text PRIMARY KEY NOT NULL,
  `tenant_id` text NOT NULL
    REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade,
  `session_id` text NOT NULL,
  `session_title` text NOT NULL,
  `project_id` text NOT NULL,
  `domain` text NOT NULL,
  -- pending: rows deleted, external state not yet fully removed (retryable)
  -- completed: everything collected was removed
  -- partial: some targets could not be removed; `failures_json` says which
  `status` text DEFAULT 'pending' NOT NULL,
  `requested_by` text,
  -- What the Session WAS, captured before the rows disappeared. This is the
  -- record the FDE can still read after the fact.
  `summary_json` text NOT NULL,
  -- Every external target, collected while the job rows still existed.
  `targets_json` text NOT NULL,
  `removed_json` text DEFAULT '[]' NOT NULL,
  `failures_json` text DEFAULT '[]' NOT NULL,
  `bytes_removed` integer DEFAULT 0 NOT NULL,
  `attempts` integer DEFAULT 0 NOT NULL,
  `created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
  `updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
  `completed_at` integer
);
--> statement-breakpoint
CREATE INDEX `ontocode_session_purges_tenant_status_idx`
  ON `ontocode_session_purges` (`tenant_id`, `status`, `created_at`);
--> statement-breakpoint
CREATE UNIQUE INDEX `ontocode_session_purges_session_uq`
  ON `ontocode_session_purges` (`tenant_id`, `session_id`);
