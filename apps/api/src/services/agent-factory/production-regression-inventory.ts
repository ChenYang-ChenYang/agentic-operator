import {
  deployments,
  eq,
  getDb,
  tenants,
  workflows,
  workflowVersions,
} from "@agentic/db";

import {
  factoryPromotionLedgerDigest,
  type FactoryPromotionRegressionLedgerSnapshot,
  type FactoryPromotionRegressionRecord,
} from "./promotion-regression-ledger";

export const FACTORY_PRODUCTION_REGRESSION_INVENTORY_SCHEMA =
  "agent-factory-production-regression-inventory/v1" as const;

export interface FactoryProductionDeploymentRow {
  deploymentId: string;
  tenantId: string;
  tenantSlug: string;
  /** Present on production DB reads; null exposes an orphan version/workflow
   * instead of silently dropping its deployment from reverse reconciliation. */
  workflowTenantId?: string | null;
  target: string;
  status: string;
  note?: string | null;
  deployedAt?: Date | string | null;
  manifest: unknown;
}

export interface FactoryProductionLiveAgentInventoryEntry {
  tenantId: string;
  tenantSlug: string;
  domain: string;
  slug: string;
  versionId: string;
  suiteFingerprint: string;
  /** Deployment that currently owns the tenant's live merged workflow. */
  deploymentId: string;
}

export interface FactoryProductionPromotionInventoryEntry {
  promotionId: string;
  tenantId: string;
  tenantSlug: string;
  domain: string;
  slugs: string[];
  versionId: string;
  suiteFingerprint: string;
  /** Original production deployment committed by this promotion. */
  deploymentId: string;
  recordHash: string;
}

export interface FactoryProductionRegressionInventory {
  schema: typeof FACTORY_PRODUCTION_REGRESSION_INVENTORY_SCHEMA;
  generatedAt: string;
  highWatermark: {
    committedCount: number;
    ledgerDigest: string;
    stateHash: string;
  };
  liveAgents: FactoryProductionLiveAgentInventoryEntry[];
  promotions: FactoryProductionPromotionInventoryEntry[];
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function manifestAgents(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(record)
    .filter((entry): entry is Record<string, unknown> => Boolean(entry));
}

function exactString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function productionFactoryOrigin(agent: Record<string, unknown>): {
  slug: string;
  domain: string;
  versionId: string;
  suiteFingerprint: string;
} | null {
  const scope = record(agent.factory_execution_scope);
  const hasFactoryMarker =
    agent.generated === true ||
    agent.factory_domain_id !== undefined ||
    agent.factory_promotion_version_id !== undefined ||
    agent.factory_regression_suite_fingerprint !== undefined ||
    scope !== null;
  if (!hasFactoryMarker) return null;
  const slug = exactString(agent.id);
  const domain = exactString(agent.factory_domain_id);
  const versionId = exactString(agent.factory_promotion_version_id);
  const suiteFingerprint = exactString(
    agent.factory_regression_suite_fingerprint,
  );
  if (
    agent.generated !== true ||
    scope?.kind !== "production" ||
    scope.target_domain_id !== domain ||
    !slug ||
    !domain ||
    !versionId ||
    !suiteFingerprint?.startsWith("regression-suite:v1:")
  ) {
    throw new Error(
      "live Factory agent has incomplete or non-production regression provenance",
    );
  }
  return { slug, domain, versionId, suiteFingerprint };
}

function matchesOrigin(
  record: FactoryPromotionRegressionRecord,
  origin: {
    slug: string;
    domain: string;
    versionId: string;
    suiteFingerprint: string;
  },
  tenantId: string,
): boolean {
  return (
    record.tenantId === tenantId &&
    record.domain === origin.domain &&
    record.versionId === origin.versionId &&
    record.suiteFingerprint === origin.suiteFingerprint &&
    record.slugs.includes(origin.slug)
  );
}

function promotionIdFromDeploymentNote(note: string | null | undefined): string | null {
  if (!note?.startsWith("agent-factory-promotion:")) return null;
  const promotionId = note
    .slice("agent-factory-promotion:".length)
    .split(";", 1)[0]
    ?.trim();
  return promotionId && /^fpr-[a-f0-9-]{8,80}$/.test(promotionId)
    ? promotionId
    : null;
}

export function factoryPromotionLedgerCoverageIssues(
  snapshot: FactoryPromotionRegressionLedgerSnapshot,
): string[] {
  const issues: string[] = [];
  if (snapshot.pending.length)
    issues.push("promotion ledger contains pending records");
  if (snapshot.highWatermarkError || !snapshot.highWatermark) {
    issues.push("promotion ledger high-watermark is missing or invalid");
  }
  const invalid = snapshot.committed.filter(
    (entry) => entry.error || !entry.record,
  );
  if (invalid.length)
    issues.push("promotion ledger contains invalid committed records");
  const records = snapshot.committed.flatMap((entry) =>
    entry.record ? [entry.record] : [],
  );
  if (!records.length)
    issues.push("promotion ledger contains no committed records");
  if (snapshot.highWatermark) {
    if (snapshot.highWatermark.committedCount !== records.length) {
      issues.push(
        "promotion ledger committed count does not match its high-watermark",
      );
    }
    if (
      snapshot.highWatermark.ledgerDigest !==
      factoryPromotionLedgerDigest(records)
    ) {
      issues.push("promotion ledger digest does not match its high-watermark");
    }
  }
  return issues;
}

/** Pure reconciliation used by both the live exporter and tests. */
export function buildFactoryProductionRegressionInventory(args: {
  deployments: FactoryProductionDeploymentRow[];
  ledger: FactoryPromotionRegressionLedgerSnapshot;
  now?: Date;
}): FactoryProductionRegressionInventory {
  const coverageIssues = factoryPromotionLedgerCoverageIssues(args.ledger);
  if (coverageIssues.length)
    throw new Error(
      `production regression inventory blocked: ${coverageIssues.join("; ")}`,
    );
  const records = args.ledger.committed.map((entry) => entry.record!);
  for (const deployment of args.deployments.filter(
    (row) => row.target === "workflow",
  )) {
    if (
      deployment.workflowTenantId !== undefined &&
      deployment.workflowTenantId !== deployment.tenantId
    ) {
      throw new Error(
        "production workflow deployment has an orphan or cross-tenant version",
      );
    }
  }
  const deploymentById = new Map(
    args.deployments.map((deployment) => [deployment.deploymentId, deployment]),
  );

  const promotions: FactoryProductionPromotionInventoryEntry[] = [];
  for (const promotion of records) {
    if (!promotion.deploymentId)
      throw new Error("committed promotion has no production deployment id");
    const deployed = deploymentById.get(promotion.deploymentId);
    if (
      !deployed ||
      deployed.target !== "workflow" ||
      (deployed.status !== "live" && deployed.status !== "rolled_back") ||
      deployed.tenantId !== promotion.tenantId ||
      deployed.tenantSlug !== promotion.tenantSlug ||
      promotionIdFromDeploymentNote(deployed.note) !== promotion.promotionId
    ) {
      throw new Error(
        "committed promotion is not anchored to the matching production deployment inventory",
      );
    }
    const agents = manifestAgents(deployed.manifest);
    for (const slug of promotion.slugs) {
      const agent = agents.find((candidate) => candidate.id === slug);
      const origin = agent ? productionFactoryOrigin(agent) : null;
      if (!origin || !matchesOrigin(promotion, origin, promotion.tenantId)) {
        throw new Error(
          "committed promotion deployment manifest does not contain its exact Factory origin",
        );
      }
    }
    promotions.push({
      promotionId: promotion.promotionId,
      tenantId: promotion.tenantId,
      tenantSlug: promotion.tenantSlug,
      domain: promotion.domain,
      slugs: [...promotion.slugs].sort(),
      versionId: promotion.versionId,
      suiteFingerprint: promotion.suiteFingerprint,
      deploymentId: promotion.deploymentId,
      recordHash: promotion.recordHash,
    });
  }


  // Reconcile the production history in the opposite direction as well. The
  // live-agent scan below cannot see a superseded promotion whose agent was
  // later replaced; every durable promotion deployment marker must therefore
  // resolve to its one exact committed record, including rolled-back rows.
  const promotionDeployments = args.deployments.filter(
    (deployment) =>
      deployment.target === "workflow" &&
      (deployment.status === "live" || deployment.status === "rolled_back") &&
      deployment.note?.startsWith("agent-factory-promotion:"),
  );
  for (const deployed of promotionDeployments) {
    const promotionId = promotionIdFromDeploymentNote(deployed.note);
    if (!promotionId) {
      throw new Error("production promotion deployment marker is invalid");
    }
    const matching = records.filter(
      (record) =>
        record.promotionId === promotionId &&
        record.deploymentId === deployed.deploymentId &&
        record.tenantId === deployed.tenantId &&
        record.tenantSlug === deployed.tenantSlug,
    );
    if (matching.length !== 1) {
      throw new Error(
        "production promotion deployment history is missing from the committed promotion ledger",
      );
    }
  }
  if (
    new Set(promotionDeployments.map((deployment) => deployment.deploymentId))
      .size !== promotionDeployments.length
  ) {
    throw new Error("production promotion deployment history contains duplicates");
  }

  const liveAgents: FactoryProductionLiveAgentInventoryEntry[] = [];
  for (const deployed of args.deployments.filter(
    (deployment) =>
      deployment.target === "workflow" && deployment.status === "live",
  )) {
    for (const agent of manifestAgents(deployed.manifest)) {
      const origin = productionFactoryOrigin(agent);
      if (!origin) continue;
      const matching = records.filter((promotion) =>
        matchesOrigin(promotion, origin, deployed.tenantId),
      );
      if (!matching.length) {
        throw new Error(
          "live Factory agent is missing from the committed promotion ledger",
        );
      }
      liveAgents.push({
        tenantId: deployed.tenantId,
        tenantSlug: deployed.tenantSlug,
        domain: origin.domain,
        slug: origin.slug,
        versionId: origin.versionId,
        suiteFingerprint: origin.suiteFingerprint,
        deploymentId: deployed.deploymentId,
      });
    }
  }
  if (!liveAgents.length) {
    throw new Error(
      "production inventory contains no live Factory-origin agents",
    );
  }

  const liveKey = (entry: FactoryProductionLiveAgentInventoryEntry) =>
    [entry.tenantId, entry.domain, entry.slug].join("\u0000");
  if (new Set(liveAgents.map(liveKey)).size !== liveAgents.length) {
    throw new Error(
      "production inventory contains duplicate live Factory agent identities",
    );
  }

  return {
    schema: FACTORY_PRODUCTION_REGRESSION_INVENTORY_SCHEMA,
    generatedAt: (args.now ?? new Date()).toISOString(),
    highWatermark: {
      committedCount: args.ledger.highWatermark!.committedCount,
      ledgerDigest: args.ledger.highWatermark!.ledgerDigest,
      stateHash: args.ledger.highWatermark!.stateHash,
    },
    liveAgents: liveAgents.sort((a, b) => liveKey(a).localeCompare(liveKey(b))),
    promotions: promotions.sort((a, b) =>
      a.promotionId.localeCompare(b.promotionId),
    ),
  };
}

export function readFactoryProductionDeploymentRows(): FactoryProductionDeploymentRow[] {
  return getDb()
    .select({
      deploymentId: deployments.id,
      tenantId: deployments.tenantId,
      tenantSlug: tenants.slug,
      workflowTenantId: workflows.tenantId,
      target: deployments.target,
      status: deployments.status,
      note: deployments.note,
      deployedAt: deployments.deployedAt,
      manifest: workflowVersions.manifestJson,
    })
    .from(deployments)
    .leftJoin(workflowVersions, eq(workflowVersions.id, deployments.versionId))
    .leftJoin(workflows, eq(workflows.id, workflowVersions.workflowId))
    .innerJoin(tenants, eq(tenants.id, deployments.tenantId))
    .where(eq(deployments.target, "workflow"))
    .all();
}
