import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "./client";
import { deployments } from "./schema";

/**
 * Durable control-plane marker for a tenant's manifest workflow on Inngest.
 *
 * `deployments.target = "runtime"` has existed since the initial schema but
 * had no producer. Reusing that lane keeps deployment state in the deployment
 * ledger and avoids adding a one-off flag to the tenant identity row.
 *
 * Legacy tenants have no marker and remain enabled for upgrade compatibility.
 * Newly-created tenants receive a disabled marker in the same transaction as
 * their identity row.
 */
export const TENANT_INNGEST_DEPLOYMENT_NOTE =
  "agentic-operator:tenant-inngest-selection:v1";
export const TENANT_INNGEST_ENABLED_VERSION =
  "tenant-inngest-selection:v1:enabled";
export const TENANT_INNGEST_DISABLED_VERSION =
  "tenant-inngest-selection:v1:disabled";

export type TenantInngestDeploymentMarker = Pick<
  typeof deployments.$inferSelect,
  | "id"
  | "tenantId"
  | "target"
  | "versionId"
  | "status"
  | "deployedBy"
  | "deployedAt"
  | "note"
>;

export function tenantInngestDeploymentMarkerId(tenantId: string): string {
  return `dpl-inngest-${tenantId}`;
}

export function tenantInngestDeploymentEnabledFromMarker(
  marker: TenantInngestDeploymentMarker | undefined,
): boolean {
  if (!marker) return true;
  return (
    marker.target === "runtime" &&
    marker.note === TENANT_INNGEST_DEPLOYMENT_NOTE &&
    marker.status === "live" &&
    marker.versionId === TENANT_INNGEST_ENABLED_VERSION
  );
}

export function getTenantInngestDeploymentMarker(
  tenantId: string,
): TenantInngestDeploymentMarker | undefined {
  return getDb()
    .select({
      id: deployments.id,
      tenantId: deployments.tenantId,
      target: deployments.target,
      versionId: deployments.versionId,
      status: deployments.status,
      deployedBy: deployments.deployedBy,
      deployedAt: deployments.deployedAt,
      note: deployments.note,
    })
    .from(deployments)
    .where(
      and(
        eq(deployments.id, tenantInngestDeploymentMarkerId(tenantId)),
        eq(deployments.tenantId, tenantId),
      ),
    )
    .all()[0];
}

/**
 * Batch-read the effective selection for tenant list/bootstrap paths.
 * Every requested tenant is present in the returned map; missing legacy
 * markers resolve to `true`.
 */
export function getTenantInngestDeploymentEnabledMap(
  tenantIds: readonly string[],
): Map<string, boolean> {
  const uniqueIds = [...new Set(tenantIds.filter(Boolean))];
  const enabledByTenant = new Map(uniqueIds.map((id) => [id, true]));
  if (uniqueIds.length === 0) return enabledByTenant;

  const rows = getDb()
    .select({
      id: deployments.id,
      tenantId: deployments.tenantId,
      target: deployments.target,
      versionId: deployments.versionId,
      status: deployments.status,
      deployedBy: deployments.deployedBy,
      deployedAt: deployments.deployedAt,
      note: deployments.note,
    })
    .from(deployments)
    .where(
      and(
        inArray(deployments.tenantId, uniqueIds),
        inArray(deployments.id, uniqueIds.map(tenantInngestDeploymentMarkerId)),
      ),
    )
    .all();

  // Only the deterministic primary-key row can influence desired state;
  // experimental or unrelated runtime deployments are ignored.
  for (const row of rows) {
    if (row.id !== tenantInngestDeploymentMarkerId(row.tenantId)) continue;
    enabledByTenant.set(
      row.tenantId,
      tenantInngestDeploymentEnabledFromMarker(row),
    );
  }
  return enabledByTenant;
}

export function isTenantInngestDeploymentEnabled(tenantId: string): boolean {
  return tenantInngestDeploymentEnabledFromMarker(
    getTenantInngestDeploymentMarker(tenantId),
  );
}
