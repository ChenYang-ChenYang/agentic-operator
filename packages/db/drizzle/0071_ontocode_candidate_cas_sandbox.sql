ALTER TABLE `ontocode_harness_jobs` ADD `candidate_package_version_id` text;
--> statement-breakpoint
ALTER TABLE `ontocode_harness_jobs` ADD `candidate_dependency_root` text;
--> statement-breakpoint
ALTER TABLE `ontocode_harness_jobs` ADD `candidate_head_id` text;
--> statement-breakpoint
ALTER TABLE `ontocode_harness_jobs` ADD `candidate_head_revision` integer;
--> statement-breakpoint
ALTER TABLE `ontocode_harness_jobs` ADD `test_cases_json` text DEFAULT '[]' NOT NULL;
--> statement-breakpoint
CREATE INDEX `ontocode_harness_jobs_candidate_package_idx` ON `ontocode_harness_jobs` (`tenant_id`,`candidate_package_version_id`);
--> statement-breakpoint
CREATE INDEX `ontocode_harness_jobs_candidate_head_idx` ON `ontocode_harness_jobs` (`tenant_id`,`candidate_head_id`,`candidate_head_revision`);
--> statement-breakpoint
ALTER TABLE `ontocode_evidence_records` ADD `state` text DEFAULT 'valid' NOT NULL;
--> statement-breakpoint
ALTER TABLE `ontocode_evidence_records` ADD `stale_reason` text;
--> statement-breakpoint
ALTER TABLE `ontocode_evidence_records` ADD `invalidated_by_package_version_id` text;
--> statement-breakpoint
ALTER TABLE `ontocode_evidence_records` ADD `invalidated_at` integer;
--> statement-breakpoint
CREATE INDEX `ontocode_evidence_records_tenant_state_created_idx` ON `ontocode_evidence_records` (`tenant_id`,`state`,`created_at`);
--> statement-breakpoint
CREATE TABLE `ontocode_evidence_invalidations` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`evidence_id` text NOT NULL,
	`caused_by_changeset_id` text NOT NULL,
	`caused_by_package_version_id` text NOT NULL,
	`reason` text NOT NULL,
	`dependency_keys_json` text DEFAULT '[]' NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`evidence_id`) REFERENCES `ontocode_evidence_records`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`caused_by_changeset_id`) REFERENCES `ontocode_changesets`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`caused_by_package_version_id`) REFERENCES `ontocode_package_versions`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ontocode_evidence_invalidations_evidence_package_uq` ON `ontocode_evidence_invalidations` (`tenant_id`,`evidence_id`,`caused_by_package_version_id`);
--> statement-breakpoint
CREATE INDEX `ontocode_evidence_invalidations_changeset_idx` ON `ontocode_evidence_invalidations` (`tenant_id`,`caused_by_changeset_id`);
--> statement-breakpoint
CREATE TABLE `ontocode_sandbox_attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`project_id` text NOT NULL,
	`session_id` text NOT NULL,
	`harness_job_id` text NOT NULL,
	`ordinal` integer NOT NULL,
	`package_version_id` text NOT NULL,
	`dependency_root` text NOT NULL,
	`ontology_hash` text NOT NULL,
	`test_suite_hash` text NOT NULL,
	`environment_profile_version_id` text,
	`factory_sandbox_attempt_id` text,
	`candidate_fingerprint` text NOT NULL,
	`bundle_hash` text,
	`status` text DEFAULT 'queued' NOT NULL,
	`qualification` text DEFAULT 'development_only' NOT NULL,
	`execution_origin` text,
	`isolation_tier` text,
	`app_id` text,
	`sandbox_tenant_slug` text,
	`registration_receipt_json` text,
	`execution_receipt_json` text,
	`test_receipt_json` text,
	`run_drain_receipt_json` text,
	`cleanup_receipt_json` text,
	`error_code` text,
	`error_message` text,
	`created_by` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`started_at` integer,
	`finished_at` integer,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `ontocode_projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`session_id`) REFERENCES `ontocode_sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`harness_job_id`) REFERENCES `ontocode_harness_jobs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`package_version_id`) REFERENCES `ontocode_package_versions`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ontocode_sandbox_attempts_harness_ordinal_uq` ON `ontocode_sandbox_attempts` (`tenant_id`,`harness_job_id`,`ordinal`);
--> statement-breakpoint
CREATE UNIQUE INDEX `ontocode_sandbox_attempts_remote_attempt_uq` ON `ontocode_sandbox_attempts` (`tenant_id`,`factory_sandbox_attempt_id`);
--> statement-breakpoint
CREATE INDEX `ontocode_sandbox_attempts_tenant_session_created_idx` ON `ontocode_sandbox_attempts` (`tenant_id`,`session_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX `ontocode_sandbox_attempts_candidate_package_idx` ON `ontocode_sandbox_attempts` (`tenant_id`,`package_version_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX `ontocode_sandbox_attempts_status_idx` ON `ontocode_sandbox_attempts` (`tenant_id`,`status`,`updated_at`);
