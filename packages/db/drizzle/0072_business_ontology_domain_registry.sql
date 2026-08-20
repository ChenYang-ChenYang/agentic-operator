CREATE TABLE `business_ontology_domains` (
  `id` text PRIMARY KEY NOT NULL,
  `tenant_id` text NOT NULL,
  `ontology_domain_id` text NOT NULL,
  `display_name` text NOT NULL,
  `source` text NOT NULL,
  `status` text DEFAULT 'active' NOT NULL,
  `is_default` integer DEFAULT false NOT NULL,
  `ontology_snapshot_hash` text,
  `catalog_metadata_json` text DEFAULT '{}' NOT NULL,
  `last_verified_at` integer,
  `last_error` text,
  `created_by` text,
  `created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
  `updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
  `archived_at` integer,
  FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `business_ontology_domains_tenant_source_domain_uq`
  ON `business_ontology_domains` (`tenant_id`, `source`, `ontology_domain_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `business_ontology_domains_one_default_per_tenant_uq`
  ON `business_ontology_domains` (`tenant_id`)
  WHERE `is_default` = 1 AND `archived_at` IS NULL;
--> statement-breakpoint
CREATE INDEX `business_ontology_domains_tenant_status_idx`
  ON `business_ontology_domains` (`tenant_id`, `status`, `updated_at`);
--> statement-breakpoint
CREATE INDEX `business_ontology_domains_domain_idx`
  ON `business_ontology_domains` (`ontology_domain_id`);
--> statement-breakpoint
ALTER TABLE `factory_runs`
  ADD `ontology_domain_registration_id` text
  REFERENCES `business_ontology_domains`(`id`) ON UPDATE no action ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE `ontocode_projects`
  ADD `ontology_domain_registration_id` text
  REFERENCES `business_ontology_domains`(`id`) ON UPDATE no action ON DELETE cascade;
--> statement-breakpoint
INSERT OR IGNORE INTO `business_ontology_domains` (
  `id`,
  `tenant_id`,
  `ontology_domain_id`,
  `display_name`,
  `source`,
  `status`,
  `is_default`,
  `catalog_metadata_json`,
  `created_at`,
  `updated_at`
)
SELECT
  'bod-' || substr(lower(hex(randomblob(16))), 1, 16),
  `tenant_id`,
  `ontology_domain_id`,
  coalesce(`ontology_domain_name`, `ontology_domain_id`),
  CASE `source`
    WHEN 'explicit' THEN 'allmeta'
    WHEN 'upload' THEN 'upload'
    ELSE 'manifest_legacy'
  END,
  'active',
  1,
  json_object('migratedFrom', 'factory_domain_bindings'),
  `created_at`,
  `updated_at`
FROM `factory_domain_bindings`;
--> statement-breakpoint
CREATE INDEX `factory_runs_registration_idx`
  ON `factory_runs` (`tenant_id`, `ontology_domain_registration_id`, `created_at`);
--> statement-breakpoint
UPDATE `ontocode_projects`
SET `ontology_domain_registration_id` = (
  SELECT `business_ontology_domains`.`id`
  FROM `business_ontology_domains`
  WHERE `business_ontology_domains`.`tenant_id` = `ontocode_projects`.`tenant_id`
    AND `business_ontology_domains`.`ontology_domain_id` = `ontocode_projects`.`domain`
  LIMIT 1
)
WHERE `ontology_domain_registration_id` IS NULL;
--> statement-breakpoint
DROP INDEX `ontocode_projects_tenant_domain_uq`;
--> statement-breakpoint
CREATE INDEX `ontocode_projects_tenant_domain_idx`
  ON `ontocode_projects` (`tenant_id`, `domain`);
--> statement-breakpoint
CREATE UNIQUE INDEX `ontocode_projects_tenant_registration_uq`
  ON `ontocode_projects` (`tenant_id`, `ontology_domain_registration_id`);
