-- #ONTOCODE-COMPREHEND — per-ontology-version understanding for the OntoCode
-- analysis lane. One row per (tenant, domain, ontology content hash); a version
-- bump misses naturally and is rebuilt as a delta from the previous row.
CREATE TABLE `ontocode_ontology_comprehension` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`domain` text NOT NULL,
	`ontology_hash` text NOT NULL,
	`source_job_id` text,
	`produced_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`schema_version` text NOT NULL,
	`annotations_json` text NOT NULL,
	`coverage_json` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ontocode_ontology_comprehension_tenant_domain_hash_uq` ON `ontocode_ontology_comprehension` (`tenant_id`,`domain`,`ontology_hash`);--> statement-breakpoint
CREATE INDEX `ontocode_ontology_comprehension_tenant_domain_idx` ON `ontocode_ontology_comprehension` (`tenant_id`,`domain`);
