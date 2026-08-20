-- OntoCode owns the stable lifecycle of a Build. Harness Jobs are replaceable
-- attempts and the Agent Factory run id is only a private engine binding.
CREATE TABLE `ontocode_build_executions` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`project_id` text NOT NULL,
	`session_id` text NOT NULL,
	`state` text DEFAULT 'new' NOT NULL,
	`ontology_hash` text NOT NULL,
	`directive_json` text NOT NULL,
	`directive_hash` text NOT NULL,
	`runtime_profile_version_id` text,
	`engine_kind` text DEFAULT 'agent_factory' NOT NULL,
	`engine_run_id` text,
	`checkpoint_digest` text,
	`checkpoint_revision` integer DEFAULT 0 NOT NULL,
	`pending_interaction_id` text,
	`pending_interaction_kind` text,
	`pending_interaction_subject_digest` text,
	`pending_answer_id` text,
	`pending_answer_digest` text,
	`pending_answer_status` text,
	`revision` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `ontocode_projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`session_id`) REFERENCES `ontocode_sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`runtime_profile_version_id`) REFERENCES `runtime_profile_versions`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `ontocode_build_executions_tenant_session_state_idx` ON `ontocode_build_executions` (`tenant_id`,`session_id`,`state`,`updated_at`);
--> statement-breakpoint
CREATE INDEX `ontocode_build_executions_tenant_project_created_idx` ON `ontocode_build_executions` (`tenant_id`,`project_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX `ontocode_build_executions_runtime_profile_version_idx` ON `ontocode_build_executions` (`tenant_id`,`runtime_profile_version_id`,`updated_at`);
--> statement-breakpoint
CREATE INDEX `ontocode_build_executions_pending_interaction_idx` ON `ontocode_build_executions` (`tenant_id`,`session_id`,`pending_interaction_id`);
--> statement-breakpoint
-- SQLite UNIQUE indexes allow multiple NULL engine ids, so new/unbound
-- executions coexist while a bound engine run can belong to only one execution.
CREATE UNIQUE INDEX `ontocode_build_executions_engine_run_uq` ON `ontocode_build_executions` (`tenant_id`,`engine_kind`,`engine_run_id`);
--> statement-breakpoint
ALTER TABLE `ontocode_harness_jobs`
  ADD `build_execution_id` text
  REFERENCES `ontocode_build_executions`(`id`) ON UPDATE no action ON DELETE set null;
--> statement-breakpoint
ALTER TABLE `ontocode_harness_jobs`
  ADD `attempt_no` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
-- Preserve the last durable logical attempt for legacy Jobs. New claims will
-- increment this column directly; Session events remain immutable audit facts.
UPDATE `ontocode_harness_jobs`
SET `attempt_no` = COALESCE((
  SELECT MAX(CAST(json_extract(`ontocode_session_events`.`payload_json`, '$.attempt') AS integer))
  FROM `ontocode_session_events`
  WHERE `ontocode_session_events`.`harness_job_id` = `ontocode_harness_jobs`.`id`
    AND `ontocode_session_events`.`type` = 'harness.job.started'
), 0);
--> statement-breakpoint
CREATE INDEX `ontocode_harness_jobs_build_execution_idx` ON `ontocode_harness_jobs` (`tenant_id`,`build_execution_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX `ontocode_harness_jobs_build_execution_attempt_idx` ON `ontocode_harness_jobs` (`build_execution_id`,`attempt_no`);
