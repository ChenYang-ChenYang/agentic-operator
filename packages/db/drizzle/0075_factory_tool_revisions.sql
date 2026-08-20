CREATE TABLE `factory_tool_revisions` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`domain_key` text DEFAULT '__unbound__' NOT NULL,
	`name` text NOT NULL,
	`version` integer NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`definition_json` text NOT NULL,
	`definition_hash` text NOT NULL,
	`validation_json` text NOT NULL,
	`source` text DEFAULT 'ontocode' NOT NULL,
	`created_by` text NOT NULL,
	`reviewed_by` text,
	`reviewed_at` integer,
	`activated_at` integer,
	`retired_at` integer,
	`activation_probe_hash` text,
	`activation_evidence_json` text,
	`supersedes_revision_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `factory_tool_revisions_scope_version_uq` ON `factory_tool_revisions` (`tenant_id`,`domain_key`,`name`,`version`);
--> statement-breakpoint
CREATE UNIQUE INDEX `factory_tool_revisions_scope_hash_uq` ON `factory_tool_revisions` (`tenant_id`,`domain_key`,`name`,`definition_hash`);
--> statement-breakpoint
CREATE INDEX `factory_tool_revisions_scope_status_idx` ON `factory_tool_revisions` (`tenant_id`,`domain_key`,`status`);
--> statement-breakpoint
CREATE UNIQUE INDEX `factory_tool_revisions_one_active_scope_uq` ON `factory_tool_revisions` (`tenant_id`,`domain_key`,`name`) WHERE `status` = 'active';
