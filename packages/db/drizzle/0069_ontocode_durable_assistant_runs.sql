CREATE TABLE `ontocode_assistant_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`session_id` text NOT NULL,
	`source_message_id` text NOT NULL,
	`status` text DEFAULT 'accepted' NOT NULL,
	`autonomy_mode` text NOT NULL,
	`policy_json` text DEFAULT '{}' NOT NULL,
	`context_hash` text,
	`context_manifest_json` text DEFAULT '{}' NOT NULL,
	`budget_json` text DEFAULT '{}' NOT NULL,
	`model` text,
	`terminal_response_json` text,
	`error_code` text,
	`error_message` text,
	`idempotency_key` text NOT NULL,
	`created_by` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`started_at` integer,
	`finished_at` integer,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`session_id`) REFERENCES `ontocode_sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_message_id`) REFERENCES `ontocode_session_messages`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ontocode_assistant_runs_session_idempotency_uq` ON `ontocode_assistant_runs` (`tenant_id`,`session_id`,`idempotency_key`);
--> statement-breakpoint
CREATE UNIQUE INDEX `ontocode_assistant_runs_source_message_uq` ON `ontocode_assistant_runs` (`tenant_id`,`source_message_id`);
--> statement-breakpoint
CREATE INDEX `ontocode_assistant_runs_tenant_session_updated_idx` ON `ontocode_assistant_runs` (`tenant_id`,`session_id`,`updated_at`);
--> statement-breakpoint
CREATE INDEX `ontocode_assistant_runs_tenant_status_updated_idx` ON `ontocode_assistant_runs` (`tenant_id`,`status`,`updated_at`);
--> statement-breakpoint
CREATE TABLE `ontocode_assistant_steps` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`session_id` text NOT NULL,
	`assistant_run_id` text NOT NULL,
	`ordinal` integer NOT NULL,
	`kind` text NOT NULL,
	`status` text DEFAULT 'running' NOT NULL,
	`attempt` integer DEFAULT 1 NOT NULL,
	`input_hash` text,
	`output_hash` text,
	`observation_json` text DEFAULT '{}' NOT NULL,
	`error_code` text,
	`error_message` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`started_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`finished_at` integer,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`session_id`) REFERENCES `ontocode_sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`assistant_run_id`) REFERENCES `ontocode_assistant_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ontocode_assistant_steps_run_ordinal_uq` ON `ontocode_assistant_steps` (`tenant_id`,`assistant_run_id`,`ordinal`);
--> statement-breakpoint
CREATE INDEX `ontocode_assistant_steps_tenant_run_updated_idx` ON `ontocode_assistant_steps` (`tenant_id`,`assistant_run_id`,`updated_at`);
--> statement-breakpoint
CREATE INDEX `ontocode_assistant_steps_tenant_session_updated_idx` ON `ontocode_assistant_steps` (`tenant_id`,`session_id`,`updated_at`);
--> statement-breakpoint
CREATE TABLE `ontocode_pinned_context_refs` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`session_id` text NOT NULL,
	`assistant_run_id` text NOT NULL,
	`ordinal` integer NOT NULL,
	`kind` text NOT NULL,
	`requested_ref` text NOT NULL,
	`canonical_ref` text NOT NULL,
	`artifact_id` text,
	`artifact_version_id` text,
	`evidence_id` text,
	`changeset_id` text,
	`content_hash` text NOT NULL,
	`metadata_json` text DEFAULT '{}' NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`session_id`) REFERENCES `ontocode_sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`assistant_run_id`) REFERENCES `ontocode_assistant_runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`artifact_id`) REFERENCES `ontocode_artifacts`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`artifact_version_id`) REFERENCES `ontocode_artifact_versions`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`evidence_id`) REFERENCES `ontocode_evidence_records`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`changeset_id`) REFERENCES `ontocode_changesets`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ontocode_pinned_context_refs_run_ordinal_uq` ON `ontocode_pinned_context_refs` (`tenant_id`,`assistant_run_id`,`ordinal`);
--> statement-breakpoint
CREATE INDEX `ontocode_pinned_context_refs_canonical_ref_idx` ON `ontocode_pinned_context_refs` (`tenant_id`,`session_id`,`canonical_ref`);
--> statement-breakpoint
CREATE INDEX `ontocode_pinned_context_refs_artifact_version_idx` ON `ontocode_pinned_context_refs` (`artifact_version_id`);
--> statement-breakpoint
CREATE INDEX `ontocode_pinned_context_refs_evidence_idx` ON `ontocode_pinned_context_refs` (`evidence_id`);
