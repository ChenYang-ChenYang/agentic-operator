/**
 * #NO-TENANT-TABLE — the registry that replaces per-customer compile-time
 * tables for machine-readable integration contracts.
 *
 * A tenant package AUTHORS its contract (env-var names, capability coordinates,
 * migration alternatives — never credentials) and bootstrap REGISTERS it here.
 * Consumers — the conversational configuration flow, the delivery-readiness
 * ledger — look contracts up by domain or tenant slug instead of importing one
 * customer's constant, so a new customer ships data, not an apps/api edit.
 *
 * "not_declared" is a first-class answer and must stay distinguishable from a
 * declared-but-empty contract: the former means this dimension COULD NOT be
 * checked; the latter means it was checked and there is nothing to report.
 */

export interface LegacyEnvAlternativeContract {
  preferredEnv: string;
  alternatives: readonly string[];
  migrationNote: string;
}

export interface IntegrationProfileContract {
  id: string;
  systemName: string;
  toolNames: readonly string[];
  requiredEnv: readonly string[];
  optionalEnv: readonly string[];
  legacyEnvAlternatives: readonly LegacyEnvAlternativeContract[];
  probeTool: string | null;
  requiredHumanFields: readonly string[];
  fdeSummary: string;
}

export interface UnresolvedExternalSystemContract {
  systemName: string;
  action: string;
  capability: string;
  disposition: string;
  fdeSummary: string;
}

export interface IntegrationContract {
  domainId: string;
  tenantSlug: string;
  profiles: readonly IntegrationProfileContract[];
  unresolvedExternalSystems: readonly UnresolvedExternalSystemContract[];
}

export type IntegrationContractLookup =
  | { status: "declared"; contract: IntegrationContract }
  | { status: "not_declared" };

const norm = (value: string): string => value.normalize("NFKC").trim().toLowerCase();

const byDomain = new Map<string, IntegrationContract>();
const byTenant = new Map<string, IntegrationContract>();

/** Boot-time registration. Re-registering a domain replaces its contract. */
export function registerIntegrationContract(
  contract: IntegrationContract,
): void {
  byDomain.set(norm(contract.domainId), contract);
  byTenant.set(norm(contract.tenantSlug), contract);
}

export function integrationContractForDomain(
  domain: string,
): IntegrationContractLookup {
  const contract = byDomain.get(norm(domain));
  return contract ? { status: "declared", contract } : { status: "not_declared" };
}

export function integrationContractForTenant(
  tenantSlug: string,
): IntegrationContractLookup {
  const contract = byTenant.get(norm(tenantSlug));
  return contract ? { status: "declared", contract } : { status: "not_declared" };
}

/** Test isolation only. */
export function clearIntegrationContractsForTest(): void {
  byDomain.clear();
  byTenant.clear();
}
