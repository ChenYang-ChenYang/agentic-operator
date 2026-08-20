-- 动态集成配置字段：System Profile 的 ConfigFieldSpec 驱动的凭证/配置表单落库。
-- config_json = 非秘密字段明文 JSON 袋（region/org id/…）；
-- secrets_* = 除主 API key 外所有秘密字段的加密 JSON 袋（AES-256-GCM，
-- 与 key_* 列同一 per-row scrypt 派生密钥方案）。
ALTER TABLE `integrations` ADD `config_json` text;--> statement-breakpoint
ALTER TABLE `integrations` ADD `secrets_cipher` text;--> statement-breakpoint
ALTER TABLE `integrations` ADD `secrets_iv` text;--> statement-breakpoint
ALTER TABLE `integrations` ADD `secrets_tag` text;--> statement-breakpoint
ALTER TABLE `integrations` ADD `secrets_salt` text;
