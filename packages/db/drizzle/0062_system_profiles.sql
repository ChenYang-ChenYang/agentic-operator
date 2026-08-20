-- OntoCode 外部系统档案：每租户每外部平台一份人审后的机器可读声明
-- (身份/别名 + api/events/data 能力 + 凭证引用 + 治理)。profile_json 为
-- @agentic/contracts SystemProfileV1 文档。
CREATE TABLE `system_profiles` (
  `id` text PRIMARY KEY NOT NULL,
  `tenant_id` text NOT NULL,
  `profile_id` text NOT NULL,
  `profile_json` text NOT NULL,
  `created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
  `updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
  FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `system_profiles_tenant_profile_uq` ON `system_profiles` (`tenant_id`,`profile_id`);
--> statement-breakpoint
CREATE INDEX `system_profiles_tenant_idx` ON `system_profiles` (`tenant_id`);
