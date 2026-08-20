-- §G2 — agent-execution LIVE window (Studio eval-test reconnection).
-- One row per accepted POST /api/agent-execution/live/executions; the
-- (tenant_slug, client_request_id) unique index is the idempotency anchor
-- (a replay returns the stored execution id instead of publishing twice).
-- Note: the companion `runs.status` addition of 'paused' (§G4 pause/resume)
-- needs no DDL — runs.status is an unchecked TEXT column; the enum lives in
-- packages/db/src/schema.ts only.
CREATE TABLE `agent_executions` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_slug` text NOT NULL,
	`agent` text NOT NULL,
	`client_request_id` text NOT NULL,
	`event_id` text,
	`request_json` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_executions_client_request_uq` ON `agent_executions` (`tenant_slug`,`client_request_id`);
--> statement-breakpoint
CREATE INDEX `agent_executions_event_idx` ON `agent_executions` (`event_id`);
--> statement-breakpoint
CREATE INDEX `agent_executions_tenant_created_idx` ON `agent_executions` (`tenant_slug`,`created_at`);
