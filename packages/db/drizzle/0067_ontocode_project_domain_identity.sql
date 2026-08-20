-- An OntoCode project is the durable container for one tenant's authoritative
-- Ontology domain. Multiple FDE tasks are sessions inside that project; they
-- are not separate projects with independent copies of the same Ontology.
--
-- CREATE first so a legacy database containing duplicate tenant/domain rows
-- fails closed without removing its existing indexes. Operators must merge
-- such rows deliberately because their sessions and evidence are durable.
CREATE UNIQUE INDEX `ontocode_projects_tenant_domain_uq`
  ON `ontocode_projects` (`tenant_id`,`domain`);
--> statement-breakpoint
DROP INDEX `ontocode_projects_tenant_domain_name_uq`;
--> statement-breakpoint
DROP INDEX `ontocode_projects_tenant_domain_idx`;
