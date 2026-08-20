CREATE TABLE `tenant_runtime_namespaces` (
  `tenant_id` text PRIMARY KEY NOT NULL
    REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade,
  `business_domain_tenant_id` text NOT NULL
    REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE restrict,
  `status` text DEFAULT 'active' NOT NULL,
  `created_by` text,
  `created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
  `updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
  `archived_at` integer
);
--> statement-breakpoint
CREATE INDEX `tenant_runtime_namespaces_owner_status_idx`
  ON `tenant_runtime_namespaces` (`business_domain_tenant_id`, `status`);
--> statement-breakpoint
CREATE TABLE `runtime_profiles` (
  `id` text PRIMARY KEY NOT NULL,
  `tenant_id` text NOT NULL
    REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade,
  `name` text NOT NULL,
  `description` text,
  `status` text DEFAULT 'active' NOT NULL,
  `created_by` text,
  `created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
  `updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
  `archived_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `runtime_profiles_tenant_name_uq`
  ON `runtime_profiles` (`tenant_id`, `name`);
--> statement-breakpoint
CREATE INDEX `runtime_profiles_tenant_status_idx`
  ON `runtime_profiles` (`tenant_id`, `status`, `updated_at`);
--> statement-breakpoint
CREATE TABLE `runtime_profile_versions` (
  `id` text PRIMARY KEY NOT NULL,
  `profile_id` text NOT NULL
    REFERENCES `runtime_profiles`(`id`) ON UPDATE no action ON DELETE restrict,
  `tenant_id` text NOT NULL
    REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade,
  `version` integer NOT NULL,
  `adapter_kind` text NOT NULL,
  `adapter_registry_slug` text NOT NULL,
  `adapter_registry_version` text NOT NULL,
  `event_namespace` text NOT NULL,
  `compatibility_tenant_id` text
    REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE restrict,
  `created_by` text,
  `created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `runtime_profile_versions_profile_version_uq`
  ON `runtime_profile_versions` (`profile_id`, `version`);
--> statement-breakpoint
CREATE INDEX `runtime_profile_versions_tenant_idx`
  ON `runtime_profile_versions` (`tenant_id`, `created_at`);
--> statement-breakpoint
CREATE INDEX `runtime_profile_versions_compat_tenant_idx`
  ON `runtime_profile_versions` (`compatibility_tenant_id`);
--> statement-breakpoint
ALTER TABLE `business_ontology_domains`
  ADD `runtime_profile_version_id` text
  REFERENCES `runtime_profile_versions`(`id`) ON UPDATE no action ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE `business_ontology_domains`
  ADD `runtime_binding_mode` text DEFAULT 'legacy_native' NOT NULL;
--> statement-breakpoint
CREATE INDEX `business_ontology_domains_runtime_profile_version_idx`
  ON `business_ontology_domains` (`tenant_id`, `runtime_profile_version_id`);
--> statement-breakpoint
ALTER TABLE `ontocode_projects`
  ADD `runtime_profile_version_id` text
  REFERENCES `runtime_profile_versions`(`id`) ON UPDATE no action ON DELETE restrict;
--> statement-breakpoint
DROP INDEX `ontocode_projects_tenant_registration_uq`;
--> statement-breakpoint
CREATE UNIQUE INDEX `ontocode_projects_tenant_registration_legacy_uq`
  ON `ontocode_projects` (`tenant_id`, `ontology_domain_registration_id`)
  WHERE `runtime_profile_version_id` IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX `ontocode_projects_tenant_registration_runtime_uq`
  ON `ontocode_projects` (
    `tenant_id`,
    `ontology_domain_registration_id`,
    `runtime_profile_version_id`
  )
  WHERE `runtime_profile_version_id` IS NOT NULL;
--> statement-breakpoint
ALTER TABLE `ontocode_sessions`
  ADD `runtime_profile_version_id` text
  REFERENCES `runtime_profile_versions`(`id`) ON UPDATE no action ON DELETE restrict;
--> statement-breakpoint
UPDATE `ontocode_sessions`
SET `runtime_profile_version_id` = (
  SELECT `ontocode_projects`.`runtime_profile_version_id`
  FROM `ontocode_projects`
  WHERE `ontocode_projects`.`id` = `ontocode_sessions`.`project_id`
);
--> statement-breakpoint
CREATE INDEX `ontocode_sessions_runtime_profile_version_idx`
  ON `ontocode_sessions` (`tenant_id`, `runtime_profile_version_id`, `updated_at`);
--> statement-breakpoint
ALTER TABLE `ontocode_harness_jobs`
  ADD `runtime_profile_version_id` text
  REFERENCES `runtime_profile_versions`(`id`) ON UPDATE no action ON DELETE restrict;
--> statement-breakpoint
UPDATE `ontocode_harness_jobs`
SET `runtime_profile_version_id` = (
  SELECT `ontocode_sessions`.`runtime_profile_version_id`
  FROM `ontocode_sessions`
  WHERE `ontocode_sessions`.`id` = `ontocode_harness_jobs`.`session_id`
);
--> statement-breakpoint
CREATE INDEX `ontocode_harness_jobs_runtime_profile_version_idx`
  ON `ontocode_harness_jobs` (`tenant_id`, `runtime_profile_version_id`, `created_at`);
--> statement-breakpoint
ALTER TABLE `factory_runs`
  ADD `runtime_profile_version_id` text
  REFERENCES `runtime_profile_versions`(`id`) ON UPDATE no action ON DELETE restrict;
--> statement-breakpoint
CREATE INDEX `factory_runs_runtime_profile_version_idx`
  ON `factory_runs` (`tenant_id`, `runtime_profile_version_id`, `created_at`);
