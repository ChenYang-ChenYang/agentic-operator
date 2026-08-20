CREATE TABLE `ontocode_package_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`project_id` text NOT NULL,
	`session_id` text NOT NULL,
	`parent_version_id` text,
	`source_harness_job_id` text,
	`ontology_hash` text NOT NULL,
	`dependency_root` text NOT NULL,
	`artifact_refs_json` text NOT NULL,
	`execution_owners_json` text NOT NULL,
	`status` text DEFAULT 'candidate_ready' NOT NULL,
	`validation_json` text DEFAULT '{}' NOT NULL,
	`idempotency_key` text NOT NULL,
	`created_by` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `ontocode_projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`session_id`) REFERENCES `ontocode_sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_harness_job_id`) REFERENCES `ontocode_harness_jobs`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ontocode_package_versions_session_idempotency_uq` ON `ontocode_package_versions` (`tenant_id`,`session_id`,`idempotency_key`);
--> statement-breakpoint
CREATE INDEX `ontocode_package_versions_tenant_session_created_idx` ON `ontocode_package_versions` (`tenant_id`,`session_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX `ontocode_package_versions_dependency_root_idx` ON `ontocode_package_versions` (`tenant_id`,`dependency_root`);
--> statement-breakpoint
CREATE INDEX `ontocode_package_versions_source_harness_job_idx` ON `ontocode_package_versions` (`source_harness_job_id`);
--> statement-breakpoint
CREATE TABLE `ontocode_candidate_heads` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`project_id` text NOT NULL,
	`session_id` text NOT NULL,
	`package_version_id` text NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`updated_by` text,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `ontocode_projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`session_id`) REFERENCES `ontocode_sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`package_version_id`) REFERENCES `ontocode_package_versions`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ontocode_candidate_heads_tenant_session_uq` ON `ontocode_candidate_heads` (`tenant_id`,`session_id`);
--> statement-breakpoint
CREATE INDEX `ontocode_candidate_heads_package_version_idx` ON `ontocode_candidate_heads` (`package_version_id`);
--> statement-breakpoint
CREATE INDEX `ontocode_candidate_heads_tenant_project_updated_idx` ON `ontocode_candidate_heads` (`tenant_id`,`project_id`,`updated_at`);
