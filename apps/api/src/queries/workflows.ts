import { and, desc, eq, isNull } from "drizzle-orm";
import {
  agents,
  deployments,
  events,
  getDb,
  runs,
  tenants,
  workflows,
  workflowVersions,
} from "@agentic/db";
import type { AgentSpec, DagAgent, DagEdge } from "@agentic/contracts";

const STAGE_PREFIX_REGEX = /^(\d+)/;
const HOT_WINDOW_MS = 60_000;

interface CanvasPosition {
  x: number;
  y: number;
}

function canvasPosition(agent: AgentSpec): CanvasPosition | undefined {
  const extensions = agent.extensions;
  if (!extensions || typeof extensions !== "object") return undefined;
  const canvas = extensions.canvas;
  if (!canvas || typeof canvas !== "object" || Array.isArray(canvas)) {
    return undefined;
  }
  const value = (canvas as Record<string, unknown>).position;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const position = value as Record<string, unknown>;
  return typeof position.x === "number" && typeof position.y === "number"
    ? { x: position.x, y: position.y }
    : undefined;
}

export async function getDag(
  tenantSlug: string,
  requestedSlug?: string,
): Promise<{
  agents: DagAgent[];
  edges: DagEdge[];
  workflowVersion: string;
  workflowVersionId: string | null;
  workflowSlug: string | null;
  workflowName: string | null;
  workflowIsLive: boolean;
}> {
  const db = getDb();
  const tenant = db
    .select()
    .from(tenants)
    .where(eq(tenants.slug, tenantSlug))
    .all()[0];
  const empty = {
    agents: [] as DagAgent[],
    edges: [] as DagEdge[],
    workflowVersion: "—",
    workflowVersionId: null,
    workflowSlug: null,
    workflowName: null,
    workflowIsLive: false,
  };
  if (!tenant) return empty;

  // Prefer the LIVE deployment's workflow_version (correct for daily ops).
  // Fall back to most-recently-created workflow_version if no live deployment.
  //
  // CRITICAL: filter to `target='workflow'`. A tenant can have multiple live
  // deployments in different lanes (e.g. raas has one `target=workflow` for
  // the manifest DAG AND one `target=tenant_code` for the code-agent
  // tarball, see deployments schema enum in packages/db/src/schema.ts:145).
  // Without this filter the ORDER BY deployedAt picks whichever was deployed
  // last, which may point at a workflow row with zero agents in the graph
  // (e.g. wf-aaab4b328451 for raas tenant_code) — leaving the Workflows
  // canvas blank even though the manifest workflow has 26 agents.
  const liveRow = db
    .select({
      workflowId: workflows.id,
      workflowSlug: workflows.slug,
      workflowName: workflows.name,
      versionId: workflowVersions.id,
      version: workflowVersions.version,
      manifestJson: workflowVersions.manifestJson,
    })
    .from(deployments)
    .innerJoin(workflowVersions, eq(workflowVersions.id, deployments.versionId))
    .innerJoin(workflows, eq(workflows.id, workflowVersions.workflowId))
    .where(
      and(
        eq(deployments.tenantId, tenant.id),
        eq(deployments.status, "live"),
        eq(deployments.target, "workflow"),
      ),
    )
    .orderBy(desc(deployments.deployedAt))
    .all()[0];

  let selected: {
    workflowId: string;
    workflowSlug: string;
    workflowName: string;
    versionId: string;
    version: string;
    manifestJson: unknown;
  } | null = null;

  if (requestedSlug) {
    const wf = db
      .select()
      .from(workflows)
      .where(
        and(
          eq(workflows.tenantId, tenant.id),
          eq(workflows.slug, requestedSlug),
        ),
      )
      .all()[0];
    if (!wf) return empty;
    const latest = db
      .select()
      .from(workflowVersions)
      .where(eq(workflowVersions.workflowId, wf.id))
      .orderBy(desc(workflowVersions.createdAt))
      .all()[0];
    if (!latest) {
      return {
        ...empty,
        workflowSlug: wf.slug,
        workflowName: wf.name,
      };
    }
    selected = {
      workflowId: wf.id,
      workflowSlug: wf.slug,
      workflowName: wf.name,
      versionId: latest.id,
      version: latest.version,
      manifestJson: latest.manifestJson,
    };
  } else if (liveRow) {
    selected = liveRow;
  } else {
    const wf = db
      .select()
      .from(workflows)
      .where(eq(workflows.tenantId, tenant.id))
      .orderBy(desc(workflows.createdAt))
      .all()[0];
    if (!wf) return empty;
    const latest = db
      .select()
      .from(workflowVersions)
      .where(eq(workflowVersions.workflowId, wf.id))
      .orderBy(desc(workflowVersions.createdAt))
      .all()[0];
    if (!latest)
      return { ...empty, workflowSlug: wf.slug, workflowName: wf.name };
    selected = {
      workflowId: wf.id,
      workflowSlug: wf.slug,
      workflowName: wf.name,
      versionId: latest.id,
      version: latest.version,
      manifestJson: latest.manifestJson,
    };
  }

  const agentRows = db
    .select({
      id: agents.id,
      kebabId: agents.kebabId,
    })
    .from(agents)
    .where(eq(agents.workflowId, selected.workflowId))
    .all();
  const rowByKebab = new Map(agentRows.map((row) => [row.kebabId, row]));
  const manifest = Array.isArray(selected.manifestJson)
    ? (selected.manifestJson as AgentSpec[])
    : selected.manifestJson &&
        typeof selected.manifestJson === "object" &&
        Array.isArray((selected.manifestJson as { agents?: unknown }).agents)
      ? ((selected.manifestJson as { agents: unknown[] }).agents as AgentSpec[])
      : [];

  const since = new Date(Date.now() - HOT_WINDOW_MS);
  const hotAgents = new Set<string>();
  const runCounts = new Map<string, number>();
  for (const r of db
    .select({ agentId: runs.agentId, startedAt: runs.startedAt })
    .from(runs)
    .where(and(eq(runs.tenantId, tenant.id), isNull(runs.deletedAt)))
    .all()) {
    if (r.startedAt && r.startedAt >= since) hotAgents.add(r.agentId);
    runCounts.set(r.agentId, (runCounts.get(r.agentId) ?? 0) + 1);
  }
  const hotEventNames = new Set<string>();
  for (const e of db
    .select({ name: events.name, receivedAt: events.receivedAt })
    .from(events)
    .where(and(eq(events.tenantId, tenant.id), isNull(events.deletedAt)))
    .all()) {
    if (e.receivedAt && e.receivedAt >= since) hotEventNames.add(e.name);
  }

  const dagAgents: DagAgent[] = manifest.map((definition) => {
    const row = rowByKebab.get(definition.id);
    const stageMatch = definition.id.match(STAGE_PREFIX_REGEX);
    const stage =
      typeof definition.stage === "number"
        ? definition.stage
        : stageMatch
          ? parseInt(stageMatch[1]!, 10)
          : 0;
    return {
      id: row?.id ?? definition.id,
      kebabId: definition.id,
      name: definition.name,
      title: definition.title ?? definition.name,
      ...(definition.title_i18n ? { titleI18n: definition.title_i18n } : {}),
      actor: definition.actor[0] === "Human" ? "Human" : "Agent",
      triggers: definition.trigger ?? [],
      emits: definition.triggered_event ?? [],
      stage,
      recentRunCount: row ? (runCounts.get(row.id) ?? 0) : 0,
      isLive: row ? hotAgents.has(row.id) : false,
      definition,
      position: canvasPosition(definition),
    };
  });

  const byEventListener = new Map<string, DagAgent[]>();
  for (const a of dagAgents) {
    for (const t of a.triggers) {
      const arr = byEventListener.get(t) ?? [];
      arr.push(a);
      byEventListener.set(t, arr);
    }
  }
  const edges: DagEdge[] = [];
  const seen = new Set<string>();
  for (const a of dagAgents) {
    for (const e of a.emits) {
      for (const b of byEventListener.get(e) ?? []) {
        const key = `${a.name}→${b.name}|${e}`;
        if (seen.has(key)) continue;
        seen.add(key);
        edges.push({
          fromAgent: a.name,
          toAgent: b.name,
          event: e,
          active: hotEventNames.has(e),
        });
      }
    }
  }

  return {
    agents: dagAgents.sort(
      (a, b) => a.stage - b.stage || a.kebabId.localeCompare(b.kebabId),
    ),
    edges,
    workflowVersion: selected.version,
    workflowVersionId: selected.versionId,
    workflowSlug: selected.workflowSlug,
    workflowName: selected.workflowName,
    workflowIsLive:
      liveRow?.workflowId === selected.workflowId &&
      liveRow.versionId === selected.versionId,
  };
}
