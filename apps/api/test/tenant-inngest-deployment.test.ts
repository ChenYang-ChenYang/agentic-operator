import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { and, eq } from "drizzle-orm";
import {
  auditLog,
  deployments,
  getDb,
  getTenantInngestDeploymentEnabledMap,
  getTenantInngestDeploymentMarker,
  isTenantInngestDeploymentEnabled,
  TENANT_INNGEST_DEPLOYMENT_NOTE,
  TENANT_INNGEST_DISABLED_VERSION,
  TENANT_INNGEST_ENABLED_VERSION,
  tenantInngestDeploymentMarkerId,
  tenants,
} from "@agentic/db";
import {
  TenantInngestDeploymentError,
  transitionTenantInngestDeployment,
  type TenantInngestRuntimeReceipt,
} from "../src/services/tenant-inngest-deployment";

const SUFFIX = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
const TENANT_ID = `ten-inngest-selection-${SUFFIX}`;
const SLUG = `inngest-selection-${SUFFIX}`.toLowerCase().slice(0, 52);
const RECEIPT: TenantInngestRuntimeReceipt = {
  appId: `agentic-operator-${SLUG}`,
  servePath: `/inngest/${SLUG}`,
  functionCount: 3,
  brokerVerified: true,
};

describe("tenant Inngest deployment transition", () => {
  beforeAll(() => {
    getDb()
      .insert(tenants)
      .values({
        id: TENANT_ID,
        slug: SLUG,
        name: "Inngest selection fixture",
      })
      .run();
  });

  beforeEach(() => {
    const db = getDb();
    db.delete(auditLog).where(eq(auditLog.tenantId, TENANT_ID)).run();
    db.delete(deployments)
      .where(eq(deployments.id, tenantInngestDeploymentMarkerId(TENANT_ID)))
      .run();
    db.update(tenants)
      .set({ archivedAt: null, updatedAt: new Date() })
      .where(eq(tenants.id, TENANT_ID))
      .run();
  });

  afterAll(() => {
    getDb().delete(tenants).where(eq(tenants.id, TENANT_ID)).run();
  });

  it("persists a stopped selection only after runtime synchronization succeeds", async () => {
    const sync = vi.fn(async () => ({ ...RECEIPT, functionCount: 0 }));
    const result = await transitionTenantInngestDeployment(
      {
        tenantId: TENANT_ID,
        slug: SLUG,
        enabled: false,
        actorUserId: null,
        callerSlug: "__system",
      },
      sync,
    );

    expect(result.changed).toBe(true);
    expect(result.receipt.functionCount).toBe(0);
    expect(sync).toHaveBeenCalledOnce();
    expect(isTenantInngestDeploymentEnabled(TENANT_ID)).toBe(false);
    expect(
      getDb()
        .select()
        .from(auditLog)
        .where(
          and(
            eq(auditLog.tenantId, TENANT_ID),
            eq(auditLog.action, "tenant.inngest.stop"),
          ),
        )
        .all(),
    ).toHaveLength(1);
  });

  it("restores the exact prior selection when Inngest rejects deployment", async () => {
    const db = getDb();
    const previousUpdatedAt = new Date(Date.now() - 30_000);
    const previousDeployedAt = new Date(Date.now() - 60_000);
    db.update(tenants)
      .set({ updatedAt: previousUpdatedAt })
      .where(eq(tenants.id, TENANT_ID))
      .run();
    db.insert(deployments)
      .values({
        id: tenantInngestDeploymentMarkerId(TENANT_ID),
        tenantId: TENANT_ID,
        target: "runtime",
        versionId: TENANT_INNGEST_DISABLED_VERSION,
        status: "live",
        deployedAt: previousDeployedAt,
        note: TENANT_INNGEST_DEPLOYMENT_NOTE,
      })
      .run();
    const sync = vi
      .fn<(slug: string) => Promise<TenantInngestRuntimeReceipt>>()
      .mockRejectedValueOnce(new Error("broker rejected registration"))
      .mockResolvedValueOnce({ ...RECEIPT, functionCount: 0 });

    await expect(
      transitionTenantInngestDeployment(
        {
          tenantId: TENANT_ID,
          slug: SLUG,
          enabled: true,
          actorUserId: null,
          callerSlug: "__system",
        },
        sync,
      ),
    ).rejects.toMatchObject<TenantInngestDeploymentError>({
      code: "inngest_sync_failed",
      statusCode: 503,
    });

    expect(sync).toHaveBeenCalledTimes(2);
    const tenantAfter = db
      .select()
      .from(tenants)
      .where(eq(tenants.id, TENANT_ID))
      .all()[0]!;
    expect(isTenantInngestDeploymentEnabled(TENANT_ID)).toBe(false);
    expect(tenantAfter.updatedAt.getTime()).toBe(previousUpdatedAt.getTime());
    expect(getTenantInngestDeploymentMarker(TENANT_ID)).toMatchObject({
      id: tenantInngestDeploymentMarkerId(TENANT_ID),
      versionId: TENANT_INNGEST_DISABLED_VERSION,
      status: "live",
      deployedAt: previousDeployedAt,
    });
    expect(
      db
        .select()
        .from(auditLog)
        .where(
          and(
            eq(auditLog.tenantId, TENANT_ID),
            eq(auditLog.action, "tenant.inngest.deploy"),
          ),
        )
        .all(),
    ).toHaveLength(0);
    expect(
      db
        .select()
        .from(auditLog)
        .where(
          and(
            eq(auditLog.tenantId, TENANT_ID),
            eq(auditLog.action, "tenant.inngest.deploy.failed"),
          ),
        )
        .all(),
    ).toHaveLength(1);
  });

  it("fails closed when the deterministic deployment marker is malformed", () => {
    getDb()
      .insert(deployments)
      .values({
        id: tenantInngestDeploymentMarkerId(TENANT_ID),
        tenantId: TENANT_ID,
        target: "runtime",
        versionId: TENANT_INNGEST_ENABLED_VERSION,
        status: "live",
        deployedAt: new Date(),
        note: "unexpected-control-marker",
      })
      .run();

    expect(isTenantInngestDeploymentEnabled(TENANT_ID)).toBe(false);
    expect(
      getTenantInngestDeploymentEnabledMap([TENANT_ID]).get(TENANT_ID),
    ).toBe(false);
  });

  it("compensates when a stop still exposes tenant functions", async () => {
    const sync = vi
      .fn<(slug: string) => Promise<TenantInngestRuntimeReceipt>>()
      .mockResolvedValue({ ...RECEIPT, functionCount: 3 });

    await expect(
      transitionTenantInngestDeployment(
        {
          tenantId: TENANT_ID,
          slug: SLUG,
          enabled: false,
          actorUserId: null,
          callerSlug: "__system",
        },
        sync,
      ),
    ).rejects.toMatchObject<TenantInngestDeploymentError>({
      code: "inngest_sync_failed",
      statusCode: 503,
    });

    expect(sync).toHaveBeenCalledTimes(2);
    expect(getTenantInngestDeploymentMarker(TENANT_ID)).toBeUndefined();
    expect(isTenantInngestDeploymentEnabled(TENANT_ID)).toBe(true);
  });
});
