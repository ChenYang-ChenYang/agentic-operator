CREATE TABLE `ontocode_projects` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`domain` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`active_package_version_id` text,
	`created_by` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ontocode_projects_tenant_domain_name_uq` ON `ontocode_projects` (`tenant_id`,`domain`,`name`);
--> statement-breakpoint
CREATE INDEX `ontocode_projects_tenant_updated_idx` ON `ontocode_projects` (`tenant_id`,`updated_at`);
--> statement-breakpoint
CREATE INDEX `ontocode_projects_tenant_domain_idx` ON `ontocode_projects` (`tenant_id`,`domain`);
--> statement-breakpoint
CREATE TABLE `ontocode_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`project_id` text NOT NULL,
	`title` text NOT NULL,
	`goal` text NOT NULL,
	`phase` text DEFAULT 'intake' NOT NULL,
	`activity_state` text DEFAULT 'idle' NOT NULL,
	`autonomy_mode` text DEFAULT 'copilot' NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`ontology_snapshot_hash` text,
	`base_package_version_id` text,
	`environment_profile_version_id` text,
	`owner_user_id` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `ontocode_projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `ontocode_sessions_tenant_project_updated_idx` ON `ontocode_sessions` (`tenant_id`,`project_id`,`updated_at`);
--> statement-breakpoint
CREATE INDEX `ontocode_sessions_tenant_state_updated_idx` ON `ontocode_sessions` (`tenant_id`,`activity_state`,`updated_at`);
--> statement-breakpoint
CREATE TABLE `ontocode_commands` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`session_id` text NOT NULL,
	`type` text NOT NULL,
	`arguments_json` text NOT NULL,
	`expected_session_revision` integer NOT NULL,
	`base_ontology_hash` text,
	`base_package_version_id` text,
	`affected_semantic_paths_json` text DEFAULT '[]' NOT NULL,
	`requested_capabilities_json` text DEFAULT '[]' NOT NULL,
	`risk_class` text DEFAULT 'draft_change' NOT NULL,
	`status` text DEFAULT 'proposed' NOT NULL,
	`requires_human` integer DEFAULT false NOT NULL,
	`rationale_summary` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`created_by` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`session_id`) REFERENCES `ontocode_sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ontocode_commands_session_idempotency_uq` ON `ontocode_commands` (`tenant_id`,`session_id`,`idempotency_key`);
--> statement-breakpoint
CREATE INDEX `ontocode_commands_tenant_session_created_idx` ON `ontocode_commands` (`tenant_id`,`session_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX `ontocode_commands_tenant_status_updated_idx` ON `ontocode_commands` (`tenant_id`,`status`,`updated_at`);
--> statement-breakpoint
CREATE TABLE `ontocode_harness_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`session_id` text NOT NULL,
	`command_id` text,
	`kind` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`idempotency_key` text NOT NULL,
	`input_hash` text,
	`budget_json` text,
	`error_message` text,
	`created_by` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`started_at` integer,
	`finished_at` integer,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`session_id`) REFERENCES `ontocode_sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`command_id`) REFERENCES `ontocode_commands`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `ontocode_harness_jobs_tenant_session_created_idx` ON `ontocode_harness_jobs` (`tenant_id`,`session_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX `ontocode_harness_jobs_tenant_status_updated_idx` ON `ontocode_harness_jobs` (`tenant_id`,`status`,`updated_at`);
--> statement-breakpoint
CREATE INDEX `ontocode_harness_jobs_command_idx` ON `ontocode_harness_jobs` (`command_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `ontocode_harness_jobs_session_idempotency_uq` ON `ontocode_harness_jobs` (`tenant_id`,`session_id`,`idempotency_key`);
--> statement-breakpoint
CREATE TABLE `ontocode_session_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`session_id` text NOT NULL,
	`role` text NOT NULL,
	`type` text DEFAULT 'text' NOT NULL,
	`content_json` text NOT NULL,
	`idempotency_key` text,
	`command_id` text,
	`correlation_id` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`session_id`) REFERENCES `ontocode_sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`command_id`) REFERENCES `ontocode_commands`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `ontocode_session_messages_tenant_session_created_idx` ON `ontocode_session_messages` (`tenant_id`,`session_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX `ontocode_session_messages_command_idx` ON `ontocode_session_messages` (`command_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `ontocode_session_messages_session_idempotency_uq` ON `ontocode_session_messages` (`tenant_id`,`session_id`,`idempotency_key`);
--> statement-breakpoint
CREATE TABLE `ontocode_session_events` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`project_id` text NOT NULL,
	`session_id` text NOT NULL,
	`seq` integer NOT NULL,
	`type` text NOT NULL,
	`visibility` text DEFAULT 'user' NOT NULL,
	`payload_json` text NOT NULL,
	`command_id` text,
	`harness_job_id` text,
	`correlation_id` text,
	`causation_id` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `ontocode_projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`session_id`) REFERENCES `ontocode_sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`command_id`) REFERENCES `ontocode_commands`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`harness_job_id`) REFERENCES `ontocode_harness_jobs`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ontocode_session_events_session_seq_uq` ON `ontocode_session_events` (`tenant_id`,`session_id`,`seq`);
--> statement-breakpoint
CREATE INDEX `ontocode_session_events_tenant_session_created_idx` ON `ontocode_session_events` (`tenant_id`,`session_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX `ontocode_session_events_correlation_idx` ON `ontocode_session_events` (`correlation_id`);
