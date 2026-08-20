/**
 * Tenant CRUD query helpers (P5-TEN-01).
 *
 * Returns lifecycle-aware tenant rows with optional batch-decorated counts
 * (agents / runs24h / openTasks). Designed so the list endpoint runs at most
 * four DB queries regardless of tenant count:
 *
 *   1. SELECT tenants            (with archive filter)
 *   2. SELECT agents JOIN workflows GROUP BY tenant_id
 *   3. SELECT runs WHERE started_at >= since GROUP BY tenant_id
 *   4. SELECT tasks WHERE status='open' GROUP BY tenant_id
 *
 * Avoids N+1 on the tenant switcher. Soft-archived tenants are excluded by
 * default; pass `includeArchived: true` to see them.
 */

import {
  and,
  desc,
  eq,
  gte,
  inArray,
  isNull,
  isNotNull,
  ne,
  or,
  sql,
} from "drizzle-orm";
import {
  agents,
  events as eventsTable,
  getDb,
  memberships,
  runs,
  tasks,
  tenants,
  tenantRuntimeNamespaces,
  tenantBudgets,
  workflows,
  deployments,
  getTenantInngestDeploymentEnabledMap,
  isTenantInngestDeploymentEnabled,
} from "@agentic/db";
import type { Tenant, TenantDetail, TenantListItem } from "@agentic/contracts";
import { isTenantInProcessDeploymentScope } from "../services/tenant-deployment-scope";

const DAY_MS = 24 * 60 * 60 * 1000;

interface ListOptions {
  /** When true, includes rows with archivedAt set. Default false. */
  includeArchived?: boolean;
  /** When provided, limits results to tenants where the user has a membership. */
  forUserId?: string | null;
  /** Platform-management escape hatch. Default product lists show only
   * canonical Business Domains, not compatibility execution namespaces. */
  includeRuntimeNamespaces?: boolean;
}

/**
 * List tenants with batched per-tenant counts. Membership-filtered when
 * `forUserId` is supplied. Returns soft-archived rows only when explicitly
 * requested.
 */
export async function listTenantsWithCounts(
  opts: ListOptions = {},
): Promise<TenantListItem[]> {
  const db = getDb();
  const since = new Date(Date.now() - DAY_MS);

  const archivePred = opts.includeArchived
    ? undefined
    : isNull(tenants.archivedAt);
  const productPred = opts.includeRuntimeNamespaces
    ? undefined
    : or(
        isNull(tenantRuntimeNamespaces.tenantId),
        ne(tenantRuntimeNamespaces.status, "active"),
      );
  const basePred =
    archivePred && productPred
      ? and(archivePred, productPred)
      : (archivePred ?? productPred);

  let rows;
  if (opts.forUserId) {
    rows = db
      .select({
        id: tenants.id,
        slug: tenants.slug,
        name: tenants.name,
        subtitle: tenants.subtitle,
        color: tenants.color,
        createdAt: tenants.createdAt,
        updatedAt: tenants.updatedAt,
        archivedAt: tenants.archivedAt,
        runtimeNamespaceTenantId: tenantRuntimeNamespaces.tenantId,
        runtimeNamespaceStatus: tenantRuntimeNamespaces.status,
        role: memberships.role,
      })
      .from(tenants)
      .innerJoin(memberships, eq(memberships.tenantId, tenants.id))
      .leftJoin(
        tenantRuntimeNamespaces,
        eq(tenantRuntimeNamespaces.tenantId, tenants.id),
      )
      .where(
        basePred
          ? and(basePred, eq(memberships.userId, opts.forUserId))
          : eq(memberships.userId, opts.forUserId),
      )
      .orderBy(desc(tenants.createdAt))
      .all();
  } else {
    rows = db
      .select({
        id: tenants.id,
        slug: tenants.slug,
        name: tenants.name,
        subtitle: tenants.subtitle,
        color: tenants.color,
        createdAt: tenants.createdAt,
        updatedAt: tenants.updatedAt,
        archivedAt: tenants.archivedAt,
        runtimeNamespaceTenantId: tenantRuntimeNamespaces.tenantId,
        runtimeNamespaceStatus: tenantRuntimeNamespaces.status,
        role: sql<null>`NULL`.as("role"),
      })
      .from(tenants)
      .leftJoin(
        tenantRuntimeNamespaces,
        eq(tenantRuntimeNamespaces.tenantId, tenants.id),
      )
      .where(basePred ?? sql`1=1`)
      .orderBy(desc(tenants.createdAt))
      .all();
  }

  if (rows.length === 0) return [];

  const tenantIds = rows.map((r) => r.id);
  const inngestEnabledByTenant =
    getTenantInngestDeploymentEnabledMap(tenantIds);

  // Batch: agent count per tenant.
  const agentRows = db
    .select({
      tenantId: workflows.tenantId,
      agentCount: sql<number>`COUNT(DISTINCT ${agents.id})`.as("agent_count"),
    })
    .from(agents)
    .innerJoin(workflows, eq(workflows.id, agents.workflowId))
    .where(inArray(workflows.tenantId, tenantIds))
    .groupBy(workflows.tenantId)
    .all();
  const agentByTenant = new Map<string, number>();
  for (const r of agentRows)
    agentByTenant.set(r.tenantId, Number(r.agentCount));

  // Batch: runs in last 24h per tenant.
  const runsRows = db
    .select({
      tenantId: runs.tenantId,
      n: sql<number>`COUNT(*)`.as("n"),
    })
    .from(runs)
    .where(
      and(
        inArray(runs.tenantId, tenantIds),
        gte(runs.startedAt, since),
        isNull(runs.deletedAt),
      ),
    )
    .groupBy(runs.tenantId)
    .all();
  const runs24hByTenant = new Map<string, number>();
  for (const r of runsRows) runs24hByTenant.set(r.tenantId, Number(r.n));

  // Batch: open tasks per tenant.
  const taskRows = db
    .select({
      tenantId: tasks.tenantId,
      n: sql<number>`COUNT(*)`.as("n"),
    })
    .from(tasks)
    .where(
      and(
        inArray(tasks.tenantId, tenantIds),
        inArray(tasks.status, ["open", "resolving"]),
        isNull(tasks.deletedAt),
      ),
    )
    .groupBy(tasks.tenantId)
    .all();
  const tasksByTenant = new Map<string, number>();
  for (const r of taskRows) tasksByTenant.set(r.tenantId, Number(r.n));

  return rows.map((r) => ({
    id: r.id,
    slug: r.slug,
    name: r.name,
    subtitle: r.subtitle ?? null,
    color: r.color ?? null,
    createdAt: r.createdAt.getTime(),
    updatedAt: r.updatedAt.getTime(),
    archivedAt: r.archivedAt ? r.archivedAt.getTime() : null,
    productKind:
      r.runtimeNamespaceTenantId &&
      r.runtimeNamespaceStatus === "active"
        ? "runtime_namespace"
        : "business_domain",
    inngestEnabled: inngestEnabledByTenant.get(r.id) ?? true,
    inngestProcessScoped: isTenantInProcessDeploymentScope(r.slug),
    agentCount: agentByTenant.get(r.id) ?? 0,
    runs24h: runs24hByTenant.get(r.id) ?? 0,
    openTasks: tasksByTenant.get(r.id) ?? 0,
    membership: r.role ?? null,
  }));
}

interface DetailOptions {
  forUserId?: string | null;
}

/**
 * Full detail row for a single tenant by slug. Includes budgets + workflow
 * counts. Returns null when the slug is unknown (404 surface).
 */
export async function getTenantDetail(
  slug: string,
  opts: DetailOptions = {},
): Promise<TenantDetail | null> {
  const db = getDb();
  const t = db.select().from(tenants).where(eq(tenants.slug, slug)).all()[0];
  if (!t) return null;
  const runtimeNamespace = db
    .select({ status: tenantRuntimeNamespaces.status })
    .from(tenantRuntimeNamespaces)
    .where(eq(tenantRuntimeNamespaces.tenantId, t.id))
    .get();

  const since = new Date(Date.now() - DAY_MS);

  const agentCount = db
    .select({ n: sql<number>`COUNT(DISTINCT ${agents.id})`.as("n") })
    .from(agents)
    .innerJoin(workflows, eq(workflows.id, agents.workflowId))
    .where(eq(workflows.tenantId, t.id))
    .all()[0]?.n;

  const runs24h = db
    .select({ n: sql<number>`COUNT(*)`.as("n") })
    .from(runs)
    .where(
      and(
        eq(runs.tenantId, t.id),
        gte(runs.startedAt, since),
        isNull(runs.deletedAt),
      ),
    )
    .all()[0]?.n;

  const openTasks = db
    .select({ n: sql<number>`COUNT(*)`.as("n") })
    .from(tasks)
    .where(
      and(
        eq(tasks.tenantId, t.id),
        inArray(tasks.status, ["open", "resolving"]),
        isNull(tasks.deletedAt),
      ),
    )
    .all()[0]?.n;

  const workflowCount = db
    .select({ n: sql<number>`COUNT(*)`.as("n") })
    .from(workflows)
    .where(eq(workflows.tenantId, t.id))
    .all()[0]?.n;

  const deploymentLiveCount = db
    .select({ n: sql<number>`COUNT(*)`.as("n") })
    .from(deployments)
    .where(
      and(
        eq(deployments.tenantId, t.id),
        eq(deployments.status, "live"),
        ne(deployments.target, "runtime"),
      ),
    )
    .all()[0]?.n;

  const budget = db
    .select()
    .from(tenantBudgets)
    .where(eq(tenantBudgets.tenantId, t.id))
    .all()[0];

  let role: "admin" | "operator" | "viewer" | null = null;
  if (opts.forUserId) {
    const m = db
      .select()
      .from(memberships)
      .where(
        and(
          eq(memberships.userId, opts.forUserId),
          eq(memberships.tenantId, t.id),
        ),
      )
      .all()[0];
    role = (m?.role as "admin" | "operator" | "viewer" | undefined) ?? null;
  }

  return {
    id: t.id,
    slug: t.slug,
    name: t.name,
    subtitle: t.subtitle ?? null,
    color: t.color ?? null,
    createdAt: t.createdAt.getTime(),
    updatedAt: t.updatedAt.getTime(),
    archivedAt: t.archivedAt ? t.archivedAt.getTime() : null,
    productKind:
      runtimeNamespace?.status === "active"
        ? "runtime_namespace"
        : "business_domain",
    inngestEnabled: isTenantInngestDeploymentEnabled(t.id),
    inngestProcessScoped: isTenantInProcessDeploymentScope(t.slug),
    agentCount: Number(agentCount ?? 0),
    runs24h: Number(runs24h ?? 0),
    openTasks: Number(openTasks ?? 0),
    workflowCount: Number(workflowCount ?? 0),
    deploymentLiveCount: Number(deploymentLiveCount ?? 0),
    membership: role,
    budgets: budget
      ? {
          monthlyTokenCap: budget.monthlyTokenCap ?? null,
          monthlyUsdCap: budget.monthlyUsdCap ?? null,
          usedTokensMonth: budget.usedTokensMonth,
          usedUsdMonth: budget.usedUsdMonth,
        }
      : null,
  };
}

/**
 * Lightweight existence check used by the create handler to surface 409
 * before the transaction begins.
 */
export function tenantSlugExists(slug: string): boolean {
  const db = getDb();
  return (
    db
      .select({ id: tenants.id })
      .from(tenants)
      .where(eq(tenants.slug, slug))
      .all().length > 0
  );
}

/**
 * Returns true when the tenant has any non-terminal runs or open tasks.
 * Archive is blocked while these exist so we never silently orphan work.
 */
export function tenantHasActiveWork(tenantId: string): {
  runs: number;
  tasks: number;
} {
  const db = getDb();
  const r = db
    .select({ n: sql<number>`COUNT(*)`.as("n") })
    .from(runs)
    .where(
      and(
        eq(runs.tenantId, tenantId),
        inArray(runs.status, ["queued", "running", "waiting"]),
        isNull(runs.deletedAt),
      ),
    )
    .all()[0];
  const tk = db
    .select({ n: sql<number>`COUNT(*)`.as("n") })
    .from(tasks)
    .where(
      and(
        eq(tasks.tenantId, tenantId),
        inArray(tasks.status, ["open", "resolving"]),
        isNull(tasks.deletedAt),
      ),
    )
    .all()[0];
  return { runs: Number(r?.n ?? 0), tasks: Number(tk?.n ?? 0) };
}

/**
 * Project the active-tenant slug list for the runtime to use when seeding
 * filesystem directories. Excludes archived tenants.
 */
export function listActiveTenantSlugs(): string[] {
  const db = getDb();
  return db
    .select({ slug: tenants.slug })
    .from(tenants)
    .where(and(isNull(tenants.archivedAt), ne(tenants.slug, "__system")))
    .all()
    .map((r) => r.slug);
}

/** Tiny helper: shape a tenants row for API responses. */
export function shapeTenantRow(row: typeof tenants.$inferSelect): Tenant {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    subtitle: row.subtitle ?? null,
    color: row.color ?? null,
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
    archivedAt: row.archivedAt ? row.archivedAt.getTime() : null,
    productKind: "business_domain",
    inngestEnabled: isTenantInngestDeploymentEnabled(row.id),
  };
}

// Re-exports so route files don't need a second import.
export { eventsTable, isNotNull };
