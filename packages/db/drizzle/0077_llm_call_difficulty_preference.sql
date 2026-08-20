-- #DIFFICULTY-ROUTING — record the model-routing ASK next to the hit.
-- `served_model` already said which model ran; nothing said which difficulty
-- the caller requested, what ordered preference it expressed, or whether the
-- tenant/workspace-allowed candidate set could satisfy it. Without these, a
-- run served by a cheap model is indistinguishable from one that was routed
-- there on purpose. Additive and nullable: null means no preference expressed.
ALTER TABLE `llm_call_telemetry` ADD `requested_tier` text;--> statement-breakpoint
ALTER TABLE `llm_call_telemetry` ADD `model_preference` text;--> statement-breakpoint
ALTER TABLE `llm_call_telemetry` ADD `preference_satisfied` integer;--> statement-breakpoint
ALTER TABLE `llm_call_telemetry` ADD `preference_reason` text;--> statement-breakpoint
CREATE INDEX `llm_call_telemetry_preference_idx` ON `llm_call_telemetry` (`requested_tier`,`preference_satisfied`);
