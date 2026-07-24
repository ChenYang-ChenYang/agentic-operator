import { and, desc, eq, ne } from "drizzle-orm";
import {
  deployments,
  getDb,
  tenants,
  users,
  workflowVersions,
  workflows,
} from "@agentic/db";
import type { DeploymentRow } from "@agentic/contracts";

async function resolveTenantId(slug: string): Promise<string | null> {
  const db = getDb();
  return db.select().from(tenants).where(eq(tenants.slug, slug)).all()[0]?.id ?? null;
}

export async function listDeployments(
  tenantSlug: string,
): Promise<DeploymentRow[]> {
  const db = getDb();
  const tenantId = await resolveTenantId(tenantSlug);
  if (!tenantId) return [];

  return db
    .select({
      id: deployments.id,
      versionId: deployments.versionId,
      status: deployments.status,
      deployedAt: deployments.deployedAt,
      deployedByName: users.name,
      note: deployments.note,
      version: workflowVersions.version,
      manifestJson: workflowVersions.manifestJson,
      workflowSlug: workflows.slug,
    })
    .from(deployments)
    .innerJoin(workflowVersions, eq(workflowVersions.id, deployments.versionId))
    .innerJoin(workflows, eq(workflows.id, workflowVersions.workflowId))
    .leftJoin(users, eq(users.id, deployments.deployedBy))
    .where(
      and(
        eq(deployments.tenantId, tenantId),
        // Tenant-level Inngest selection is an internal control-plane marker,
        // not a workflow-version history row rendered on this page.
        ne(deployments.target, "runtime"),
      ),
    )
    .orderBy(desc(deployments.deployedAt))
    .all()
    .map((r) => {
      const m = (r.manifestJson ?? []) as unknown[];
      return {
        id: r.id,
        versionId: r.versionId,
        versionString: r.version,
        status: r.status,
        deployedAt: r.deployedAt,
        deployedBy: r.deployedByName ?? null,
        note: r.note,
        workflowSlug: r.workflowSlug,
        agentCount: Array.isArray(m) ? m.length : 0,
      };
    });
}

export async function getLiveDeployment(
  tenantSlug: string,
): Promise<DeploymentRow | null> {
  const db = getDb();
  const tenantId = await resolveTenantId(tenantSlug);
  if (!tenantId) return null;

  const row = db
    .select({
      id: deployments.id,
      versionId: deployments.versionId,
      status: deployments.status,
      deployedAt: deployments.deployedAt,
      deployedByName: users.name,
      note: deployments.note,
      version: workflowVersions.version,
      manifestJson: workflowVersions.manifestJson,
      workflowSlug: workflows.slug,
    })
    .from(deployments)
    .innerJoin(workflowVersions, eq(workflowVersions.id, deployments.versionId))
    .innerJoin(workflows, eq(workflows.id, workflowVersions.workflowId))
    .leftJoin(users, eq(users.id, deployments.deployedBy))
    .where(
      and(
        eq(deployments.tenantId, tenantId),
        eq(deployments.status, "live"),
        // Filter to the workflow lane — a tenant can have multiple live
        // deployments in parallel lanes (workflow, tenant_code, agent,
        // runtime, code_agent). The "Live Workflow" card on the
        // Deployments page is specifically about the manifest graph; it
        // must NOT show a row from another lane (e.g. raas has a
        // tenant_code live deployment 9 sec newer than its workflow
        // deployment — without this filter the card would surface the
        // wrong workflow version + agent count). Audit history (via
        // listDeployments) deliberately shows all lanes.
        eq(deployments.target, "workflow"),
      ),
    )
    .orderBy(desc(deployments.deployedAt))
    .all()[0];

  if (!row) return null;
  const m = (row.manifestJson ?? []) as unknown[];
  return {
    id: row.id,
    versionId: row.versionId,
    versionString: row.version,
    status: row.status,
    deployedAt: row.deployedAt,
    deployedBy: row.deployedByName ?? null,
    note: row.note,
    workflowSlug: row.workflowSlug,
    agentCount: Array.isArray(m) ? m.length : 0,
  };
}
