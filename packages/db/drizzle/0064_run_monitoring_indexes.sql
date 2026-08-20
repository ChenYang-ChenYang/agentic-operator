CREATE INDEX IF NOT EXISTS `runs_tenant_deleted_queued_idx`
  ON `runs` (`tenant_id`, `deleted_at`, `queued_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `runs_tenant_deleted_status_queued_idx`
  ON `runs` (`tenant_id`, `deleted_at`, `status`, `queued_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `runs_tenant_source_queued_idx`
  ON `runs` (`tenant_id`, `invocation_source`, `queued_at`);
