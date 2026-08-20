/**
 * #NO-TENANT-TABLE — boot-time registration of tenant-authored integration
 * contracts.
 *
 * `integration-contract-registry.ts` is deliberately empty at module load: a
 * tenant package AUTHORS its contract (env-var names, capability coordinates,
 * migration alternatives — never credentials) and this module is the single
 * place that REGISTERS it. Consumers (the conversational configuration flow,
 * the delivery-readiness ledger) then look contracts up by domain or tenant
 * slug instead of importing one customer's constant.
 *
 * `bootstrap.ts` imports this file for its SIDE EFFECT only, so registration
 * happens exactly once, before any consumer resolves a lookup. Without it every
 * lookup answers "not_declared", which is indistinguishable from a tenant that
 * genuinely declared nothing — the failure is silent rather than loud, so keep
 * this import even when the list below has a single entry.
 *
 * Onboarding a customer = add its package's contract here; no consumer changes.
 */

import {
  AGENTS_GENERATION_DOMAIN_ID,
  AGENTS_GENERATION_INTEGRATION_PROFILES,
  AGENTS_GENERATION_TENANT_SLUG,
  AGENTS_GENERATION_UNRESOLVED_EXTERNAL_SYSTEMS,
} from "@tenants/agents-generation";
import {
  registerIntegrationContract,
  type IntegrationContract,
} from "./integration-contract-registry";

/**
 * The tenant profile type is a superset of `IntegrationProfileContract` (it also
 * carries `actions` and the generation/runtime policies the factory reads), so
 * the values satisfy the registry's narrower shape structurally.
 */
const CONTRACTS: readonly IntegrationContract[] = [
  {
    domainId: AGENTS_GENERATION_DOMAIN_ID,
    tenantSlug: AGENTS_GENERATION_TENANT_SLUG,
    profiles: Object.values(AGENTS_GENERATION_INTEGRATION_PROFILES),
    unresolvedExternalSystems: AGENTS_GENERATION_UNRESOLVED_EXTERNAL_SYSTEMS,
  },
];

for (const contract of CONTRACTS) {
  registerIntegrationContract(contract);
}
