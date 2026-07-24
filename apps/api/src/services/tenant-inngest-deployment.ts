import { and, eq } from "drizzle-orm";
import {
  auditLog,
  deployments,
  getDb,
  getTenantInngestDeploymentMarker,
  TENANT_INNGEST_DEPLOYMENT_NOTE,
  TENANT_INNGEST_DISABLED_VERSION,
  TENANT_INNGEST_ENABLED_VERSION,
  tenantInngestDeploymentEnabledFromMarker,
  tenantInngestDeploymentMarkerId,
  tenants,
} from "@agentic/db";
import { makeId } from "@agentic/shared";
import { DurableLeaseBusyError } from "./durable-lease";
import { withTenantRuntimeMutationLease } from "./tenant-runtime-mutation";

export interface TenantInngestRuntimeReceipt {
  appId: string;
  servePath: string;
  functionCount: number;
  brokerVerified: boolean;
}

export class TenantInngestDeploymentError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode: number,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "TenantInngestDeploymentError";
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Persist and activate one tenant's Inngest deployment selection.
 *
 * The existing `deployments.target = "runtime"` lane is the durable desired
 * state. Runtime/broker synchronization is part of the same compensated
 * operation: when Inngest rejects the new state, the deployment marker, local
 * registry, broker registration, and success audit are restored before the
 * endpoint reports failure.
 */
export async function transitionTenantInngestDeployment(
  args: {
    tenantId: string;
    slug: string;
    enabled: boolean;
    actorUserId: string | null;
    callerSlug: string;
  },
  syncRuntime: (slug: string) => Promise<TenantInngestRuntimeReceipt>,
): Promise<{
  changed: boolean;
  changedAt: Date;
  receipt: TenantInngestRuntimeReceipt;
}> {
  try {
    return await withTenantRuntimeMutationLease({
      tenantId: args.tenantId,
      kind: "tenant_inngest_deployment",
      workId: `${args.enabled ? "deploy" : "stop"}:${args.slug}`,
      ttlMs: 2 * 60 * 1000,
      waitMs: 0,
      fn: async (lease) => {
        lease.assertOwned();
        const db = getDb();
        const before = db
          .select()
          .from(tenants)
          .where(
            and(eq(tenants.id, args.tenantId), eq(tenants.slug, args.slug)),
          )
          .all()[0];
        if (!before) {
          throw new TenantInngestDeploymentError(
            "tenant_not_found",
            `no tenant with slug "${args.slug}"`,
            404,
          );
        }
        if (before.archivedAt) {
          throw new TenantInngestDeploymentError(
            "tenant_archived",
            `tenant "${args.slug}" is archived and cannot change Inngest deployment state`,
            409,
          );
        }

        const beforeMarker = getTenantInngestDeploymentMarker(before.id);
        const beforeEnabled =
          tenantInngestDeploymentEnabledFromMarker(beforeMarker);
        const changed = beforeEnabled !== args.enabled;
        const changedAt = new Date();
        const markerId = tenantInngestDeploymentMarkerId(before.id);
        // The control marker itself is always live. Desired state is encoded
        // by versionId so rolled-back history GC can never delete a disabled
        // marker and accidentally fall back to legacy-enabled behavior.
        const desiredStatus = "live";
        const desiredVersion = args.enabled
          ? TENANT_INNGEST_ENABLED_VERSION
          : TENANT_INNGEST_DISABLED_VERSION;
        const action = args.enabled
          ? "tenant.inngest.deploy"
          : "tenant.inngest.stop";
        const successAuditId = makeId("aud");

        if (changed) {
          db.transaction((tx) => {
            if (beforeMarker) {
              const updated = tx
                .update(deployments)
                .set({
                  versionId: desiredVersion,
                  status: desiredStatus,
                  deployedBy: args.actorUserId,
                  deployedAt: changedAt,
                })
                .where(
                  and(
                    eq(deployments.id, markerId),
                    eq(deployments.tenantId, before.id),
                    eq(deployments.target, "runtime"),
                    eq(deployments.note, TENANT_INNGEST_DEPLOYMENT_NOTE),
                    eq(deployments.versionId, beforeMarker.versionId),
                    eq(deployments.status, beforeMarker.status),
                    eq(deployments.deployedAt, beforeMarker.deployedAt),
                  ),
                )
                .run() as { changes?: number };
              if ((updated.changes ?? 0) !== 1) {
                throw new TenantInngestDeploymentError(
                  "tenant_state_changed",
                  `tenant "${args.slug}" changed while its Inngest deployment was updating`,
                  409,
                );
              }
            } else {
              try {
                tx.insert(deployments)
                  .values({
                    id: markerId,
                    tenantId: before.id,
                    target: "runtime",
                    versionId: desiredVersion,
                    status: desiredStatus,
                    deployedBy: args.actorUserId,
                    deployedAt: changedAt,
                    note: TENANT_INNGEST_DEPLOYMENT_NOTE,
                  })
                  .run();
              } catch (cause) {
                throw new TenantInngestDeploymentError(
                  "tenant_state_changed",
                  `tenant "${args.slug}" changed while its Inngest deployment was updating`,
                  409,
                  { cause },
                );
              }
            }

            const tenantUpdated = tx
              .update(tenants)
              .set({ updatedAt: changedAt })
              .where(
                and(
                  eq(tenants.id, before.id),
                  eq(tenants.updatedAt, before.updatedAt),
                ),
              )
              .run() as { changes?: number };
            if ((tenantUpdated.changes ?? 0) !== 1) {
              throw new TenantInngestDeploymentError(
                "tenant_state_changed",
                `tenant "${args.slug}" metadata changed while its Inngest deployment was updating`,
                409,
              );
            }
            tx.insert(auditLog)
              .values({
                id: successAuditId,
                tenantId: before.id,
                actorUserId: args.actorUserId,
                action,
                targetType: "tenant",
                targetId: before.id,
                at: changedAt,
                metaJson: {
                  slug: args.slug,
                  enabled: args.enabled,
                  previous_enabled: beforeEnabled,
                  deployment_marker_id: markerId,
                  by_tenant: args.callerSlug,
                } as never,
              })
              .run();
          });
        }
        try {
          lease.assertOwned();
          const receipt = await syncRuntime(args.slug);
          if (!args.enabled && receipt.functionCount !== 0) {
            throw new Error(
              `Inngest still reports ${receipt.functionCount} function(s) for stopped tenant "${args.slug}"`,
            );
          }
          lease.assertOwned();
          return { changed, changedAt, receipt };
        } catch (syncError) {
          if (!changed) {
            throw new TenantInngestDeploymentError(
              "inngest_sync_failed",
              `Inngest did not confirm the current deployment state for tenant "${args.slug}"`,
              503,
              { cause: syncError },
            );
          }

          const compensationErrors: Error[] = [
            syncError instanceof Error
              ? syncError
              : new Error(String(syncError)),
          ];
          let databaseRestored = false;
          let runtimeRestored = false;
          try {
            db.transaction((tx) => {
              if (beforeMarker) {
                const reverted = tx
                  .update(deployments)
                  .set({
                    target: beforeMarker.target,
                    versionId: beforeMarker.versionId,
                    status: beforeMarker.status,
                    deployedBy: beforeMarker.deployedBy,
                    deployedAt: beforeMarker.deployedAt,
                    note: beforeMarker.note,
                  })
                  .where(
                    and(
                      eq(deployments.id, markerId),
                      eq(deployments.tenantId, before.id),
                      eq(deployments.target, "runtime"),
                      eq(deployments.note, TENANT_INNGEST_DEPLOYMENT_NOTE),
                      eq(deployments.versionId, desiredVersion),
                      eq(deployments.status, desiredStatus),
                      eq(deployments.deployedAt, changedAt),
                    ),
                  )
                  .run() as { changes?: number };
                if ((reverted.changes ?? 0) !== 1) {
                  throw new Error(
                    `tenant ${args.slug} Inngest compensation lost its deployment-marker compare-and-swap`,
                  );
                }
              } else {
                const removed = tx
                  .delete(deployments)
                  .where(
                    and(
                      eq(deployments.id, markerId),
                      eq(deployments.tenantId, before.id),
                      eq(deployments.target, "runtime"),
                      eq(deployments.note, TENANT_INNGEST_DEPLOYMENT_NOTE),
                      eq(deployments.versionId, desiredVersion),
                      eq(deployments.status, desiredStatus),
                      eq(deployments.deployedAt, changedAt),
                    ),
                  )
                  .run() as { changes?: number };
                if ((removed.changes ?? 0) !== 1) {
                  throw new Error(
                    `tenant ${args.slug} Inngest compensation could not remove its deployment marker`,
                  );
                }
              }

              // Restore the presentation timestamp only when no independent
              // tenant edit landed after this transition.
              tx.update(tenants)
                .set({ updatedAt: before.updatedAt })
                .where(
                  and(
                    eq(tenants.id, before.id),
                    eq(tenants.updatedAt, changedAt),
                  ),
                )
                .run();
              tx.delete(auditLog).where(eq(auditLog.id, successAuditId)).run();
            });
            databaseRestored = true;
          } catch (error) {
            compensationErrors.push(
              error instanceof Error ? error : new Error(String(error)),
            );
          }

          if (databaseRestored) {
            try {
              await syncRuntime(args.slug);
              runtimeRestored = true;
            } catch (error) {
              compensationErrors.push(
                error instanceof Error ? error : new Error(String(error)),
              );
            }
          }

          try {
            db.insert(auditLog)
              .values({
                id: makeId("aud"),
                tenantId: before.id,
                actorUserId: args.actorUserId,
                action: `${action}.failed`,
                targetType: "tenant",
                targetId: before.id,
                at: new Date(),
                metaJson: {
                  slug: args.slug,
                  enabled: args.enabled,
                  by_tenant: args.callerSlug,
                  error: errorMessage(syncError),
                  database_restored: databaseRestored,
                  runtime_restored: runtimeRestored,
                } as never,
              })
              .run();
          } catch (error) {
            compensationErrors.push(
              error instanceof Error ? error : new Error(String(error)),
            );
          }

          const compensated = databaseRestored && runtimeRestored;
          throw new TenantInngestDeploymentError(
            compensated
              ? "inngest_sync_failed"
              : "tenant_inngest_compensation_failed",
            compensated
              ? `Inngest rejected the deployment change for tenant "${args.slug}"; the prior state was restored`
              : `Inngest deployment change for tenant "${args.slug}" failed and compensation was incomplete`,
            compensated ? 503 : 500,
            { cause: new AggregateError(compensationErrors) },
          );
        }
      },
    });
  } catch (error) {
    if (error instanceof DurableLeaseBusyError) {
      throw new TenantInngestDeploymentError(
        "tenant_runtime_busy",
        `tenant "${args.slug}" already has a runtime mutation in progress`,
        409,
        { cause: error },
      );
    }
    throw error;
  }
}
