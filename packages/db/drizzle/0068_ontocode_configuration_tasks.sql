CREATE TABLE `ontocode_configuration_tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`project_id` text NOT NULL,
	`session_id` text NOT NULL,
	`source_command_id` text,
	`waiting_harness_job_id` text,
	`source_requirement_id` text,
	`source_action_name` text,
	`source_receipt_digest` text,
	`blocker_key` text NOT NULL,
	`title` text NOT NULL,
	`target_kind` text NOT NULL,
	`target_json` text NOT NULL,
	`requirement_json` text NOT NULL,
	`verification_policy_json` text NOT NULL,
	`resume_action` text,
	`ontology_hash` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`last_verification_json` text,
	`last_verification_idempotency_key` text,
	`resolution_note` text,
	`idempotency_key` text NOT NULL,
	`created_by` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`verification_started_at` integer,
	`verified_at` integer,
	`cancelled_at` integer,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `ontocode_projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`session_id`) REFERENCES `ontocode_sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_command_id`) REFERENCES `ontocode_commands`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`waiting_harness_job_id`) REFERENCES `ontocode_harness_jobs`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ontocode_configuration_tasks_session_idempotency_uq` ON `ontocode_configuration_tasks` (`tenant_id`,`session_id`,`idempotency_key`);
--> statement-breakpoint
CREATE INDEX `ontocode_configuration_tasks_tenant_session_updated_idx` ON `ontocode_configuration_tasks` (`tenant_id`,`session_id`,`updated_at`);
--> statement-breakpoint
CREATE INDEX `ontocode_configuration_tasks_tenant_status_updated_idx` ON `ontocode_configuration_tasks` (`tenant_id`,`status`,`updated_at`);
--> statement-breakpoint
CREATE INDEX `ontocode_configuration_tasks_tenant_session_blocker_idx` ON `ontocode_configuration_tasks` (`tenant_id`,`session_id`,`blocker_key`);
--> statement-breakpoint
CREATE INDEX `ontocode_configuration_tasks_source_command_idx` ON `ontocode_configuration_tasks` (`source_command_id`);
--> statement-breakpoint
CREATE INDEX `ontocode_configuration_tasks_waiting_job_idx` ON `ontocode_configuration_tasks` (`waiting_harness_job_id`);
--> statement-breakpoint
CREATE INDEX `ontocode_configuration_tasks_waiting_requirement_idx` ON `ontocode_configuration_tasks` (`tenant_id`,`waiting_harness_job_id`,`source_requirement_id`);
