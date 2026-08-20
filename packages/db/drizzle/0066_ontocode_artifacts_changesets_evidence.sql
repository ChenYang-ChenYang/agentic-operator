CREATE TABLE `ontocode_changesets` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`project_id` text NOT NULL,
	`session_id` text NOT NULL,
	`command_id` text,
	`status` text DEFAULT 'proposed' NOT NULL,
	`summary` text NOT NULL,
	`base_ontology_hash` text,
	`base_package_version_id` text,
	`expected_session_revision` integer NOT NULL,
	`idempotency_key` text NOT NULL,
	`created_by` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`committed_at` integer,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `ontocode_projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`session_id`) REFERENCES `ontocode_sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`command_id`) REFERENCES `ontocode_commands`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ontocode_changesets_session_idempotency_uq` ON `ontocode_changesets` (`tenant_id`,`session_id`,`idempotency_key`);
--> statement-breakpoint
CREATE INDEX `ontocode_changesets_tenant_session_created_idx` ON `ontocode_changesets` (`tenant_id`,`session_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX `ontocode_changesets_tenant_status_updated_idx` ON `ontocode_changesets` (`tenant_id`,`status`,`updated_at`);
--> statement-breakpoint
CREATE INDEX `ontocode_changesets_command_idx` ON `ontocode_changesets` (`command_id`);
--> statement-breakpoint
CREATE TABLE `ontocode_changeset_operations` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`changeset_id` text NOT NULL,
	`ordinal` integer NOT NULL,
	`operation` text NOT NULL,
	`semantic_path` text NOT NULL,
	`from_semantic_path` text,
	`before_json` text NOT NULL,
	`after_json` text NOT NULL,
	`source_refs_json` text DEFAULT '[]' NOT NULL,
	`invalidates_json` text DEFAULT '[]' NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`changeset_id`) REFERENCES `ontocode_changesets`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ontocode_changeset_operations_changeset_ordinal_uq` ON `ontocode_changeset_operations` (`tenant_id`,`changeset_id`,`ordinal`);
--> statement-breakpoint
CREATE INDEX `ontocode_changeset_operations_semantic_path_idx` ON `ontocode_changeset_operations` (`tenant_id`,`semantic_path`);
--> statement-breakpoint
CREATE TABLE `ontocode_artifacts` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`project_id` text NOT NULL,
	`session_id` text NOT NULL,
	`logical_name` text NOT NULL,
	`kind` text NOT NULL,
	`semantic_path` text,
	`created_by` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `ontocode_projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`session_id`) REFERENCES `ontocode_sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ontocode_artifacts_session_logical_name_uq` ON `ontocode_artifacts` (`tenant_id`,`session_id`,`logical_name`);
--> statement-breakpoint
CREATE INDEX `ontocode_artifacts_tenant_session_created_idx` ON `ontocode_artifacts` (`tenant_id`,`session_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX `ontocode_artifacts_tenant_kind_idx` ON `ontocode_artifacts` (`tenant_id`,`kind`);
--> statement-breakpoint
CREATE TABLE `ontocode_artifact_blobs` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`sha256` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`content_text` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ontocode_artifact_blobs_tenant_sha_uq` ON `ontocode_artifact_blobs` (`tenant_id`,`sha256`);
--> statement-breakpoint
CREATE TABLE `ontocode_artifact_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`artifact_id` text NOT NULL,
	`session_id` text NOT NULL,
	`changeset_id` text,
	`blob_id` text NOT NULL,
	`version` integer NOT NULL,
	`blob_hash` text NOT NULL,
	`content_type` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`metadata_json` text DEFAULT '{}' NOT NULL,
	`idempotency_key` text NOT NULL,
	`created_by` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`artifact_id`) REFERENCES `ontocode_artifacts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`session_id`) REFERENCES `ontocode_sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`changeset_id`) REFERENCES `ontocode_changesets`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`blob_id`) REFERENCES `ontocode_artifact_blobs`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ontocode_artifact_versions_artifact_version_uq` ON `ontocode_artifact_versions` (`tenant_id`,`artifact_id`,`version`);
--> statement-breakpoint
CREATE UNIQUE INDEX `ontocode_artifact_versions_session_idempotency_uq` ON `ontocode_artifact_versions` (`tenant_id`,`session_id`,`idempotency_key`);
--> statement-breakpoint
CREATE INDEX `ontocode_artifact_versions_tenant_session_created_idx` ON `ontocode_artifact_versions` (`tenant_id`,`session_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX `ontocode_artifact_versions_blob_idx` ON `ontocode_artifact_versions` (`blob_id`);
--> statement-breakpoint
CREATE INDEX `ontocode_artifact_versions_changeset_idx` ON `ontocode_artifact_versions` (`changeset_id`);
--> statement-breakpoint
CREATE TABLE `ontocode_evidence_records` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`project_id` text NOT NULL,
	`session_id` text NOT NULL,
	`harness_job_id` text,
	`changeset_id` text,
	`artifact_version_id` text,
	`kind` text NOT NULL,
	`outcome` text NOT NULL,
	`subject_type` text NOT NULL,
	`subject_id` text NOT NULL,
	`subject_digest` text NOT NULL,
	`dependency_set_json` text NOT NULL,
	`validity_predicate_json` text NOT NULL,
	`refs_json` text DEFAULT '[]' NOT NULL,
	`summary` text NOT NULL,
	`producer` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`recorded_by` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `ontocode_projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`session_id`) REFERENCES `ontocode_sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`harness_job_id`) REFERENCES `ontocode_harness_jobs`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`changeset_id`) REFERENCES `ontocode_changesets`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`artifact_version_id`) REFERENCES `ontocode_artifact_versions`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ontocode_evidence_records_session_idempotency_uq` ON `ontocode_evidence_records` (`tenant_id`,`session_id`,`idempotency_key`);
--> statement-breakpoint
CREATE INDEX `ontocode_evidence_records_tenant_session_created_idx` ON `ontocode_evidence_records` (`tenant_id`,`session_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX `ontocode_evidence_records_tenant_kind_outcome_idx` ON `ontocode_evidence_records` (`tenant_id`,`kind`,`outcome`);
--> statement-breakpoint
CREATE INDEX `ontocode_evidence_records_harness_job_idx` ON `ontocode_evidence_records` (`harness_job_id`);
--> statement-breakpoint
CREATE INDEX `ontocode_evidence_records_subject_idx` ON `ontocode_evidence_records` (`tenant_id`,`subject_type`,`subject_id`);
