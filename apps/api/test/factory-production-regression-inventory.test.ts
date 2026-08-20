import { describe, expect, it } from "vitest";

import {
  FACTORY_PROMOTION_HIGH_WATERMARK_SCHEMA,
  FACTORY_PROMOTION_REGRESSION_SCHEMA,
  factoryPromotionLedgerDigest,
  type FactoryPromotionRegressionLedgerSnapshot,
  type FactoryPromotionRegressionRecord,
} from "../src/services/agent-factory/promotion-regression-ledger";
import {
  buildFactoryProductionRegressionInventory,
  type FactoryProductionDeploymentRow,
} from "../src/services/agent-factory/production-regression-inventory";

const tenantId = "ten-inventory";
const tenantSlug = "inventory-tenant";
const domain = "Agents-generation";
const versionId = "v-inventory-1";
const suiteFingerprint = `regression-suite:v1:${"a".repeat(64)}`;
const deploymentId = "dpl-inventory-origin";

function promotion(
  overrides: Partial<FactoryPromotionRegressionRecord> = {},
): FactoryPromotionRegressionRecord {
  return {
    schema: FACTORY_PROMOTION_REGRESSION_SCHEMA,
    promotionId: "fpr-a1b2c3d4",
    tenantId,
    tenantSlug,
    domain,
    versionId,
    slugs: ["resume-parser"],
    artifact:
      "factory-drafts/_tenants/x/versions/v-inventory-1/regression.json",
    evidenceFingerprint: "sandbox-evidence:v2:inventory",
    suiteFingerprint,
    sandboxCleanupReceiptHash: `sandbox-cleanup:v1:${"b".repeat(64)}`,
    reviewReceiptId: "review-inventory",
    deploymentId,
    stagedAt: "2026-07-15T00:00:00.000Z",
    committedAt: "2026-07-15T00:01:00.000Z",
    recordHash: `factory-promotion-regression:v2:${"c".repeat(64)}`,
    ...overrides,
  };
}

function ledger(
  records = [promotion()],
): FactoryPromotionRegressionLedgerSnapshot {
  return {
    dataRoot: "/withheld",
    pending: [],
    committed: records.map((record, index) => ({
      file: `/withheld/${index}.json`,
      record,
    })),
    highWatermark: {
      schema: FACTORY_PROMOTION_HIGH_WATERMARK_SCHEMA,
      committedCount: records.length,
      ledgerDigest: factoryPromotionLedgerDigest(records),
      previousStateHash: null,
      appendedPromotionId: records.at(-1)?.promotionId ?? "fpr-empty0000",
      appendedRecordHash:
        records.at(-1)?.recordHash ??
        `factory-promotion-regression:v2:${"0".repeat(64)}`,
      updatedAt: "2026-07-15T00:02:00.000Z",
      stateHash: `factory-promotion-high-watermark:v1:${"d".repeat(64)}`,
    },
  };
}

function factoryAgent(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: "resume-parser",
    generated: true,
    factory_domain_id: domain,
    factory_promotion_version_id: versionId,
    factory_regression_suite_fingerprint: suiteFingerprint,
    factory_execution_scope: {
      kind: "production",
      target_domain_id: domain,
    },
    ...overrides,
  };
}

function deployments(
  liveAgents: Record<string, unknown>[] = [factoryAgent()],
  originAgents: Record<string, unknown>[] = [factoryAgent()],
): FactoryProductionDeploymentRow[] {
  return [
    {
      deploymentId,
      tenantId,
      tenantSlug,
      target: "workflow",
      status: "rolled_back",
      note: `agent-factory-promotion:${promotion().promotionId}`,
      manifest: originAgents,
    },
    {
      deploymentId: "dpl-inventory-live",
      tenantId,
      tenantSlug,
      target: "workflow",
      status: "live",
      manifest: liveAgents,
    },
  ];
}

describe("Factory production regression inventory", () => {
  it("reconciles each live Factory agent to an exact committed promotion", () => {
    const inventory = buildFactoryProductionRegressionInventory({
      deployments: deployments(),
      ledger: ledger(),
      now: new Date("2026-07-15T00:03:00.000Z"),
    });

    expect(inventory).toMatchObject({
      schema: "agent-factory-production-regression-inventory/v1",
      highWatermark: { committedCount: 1 },
      liveAgents: [
        {
          tenantId,
          tenantSlug,
          domain,
          slug: "resume-parser",
          versionId,
          suiteFingerprint,
          deploymentId: "dpl-inventory-live",
        },
      ],
      promotions: [
        {
          promotionId: "fpr-a1b2c3d4",
          deploymentId,
          slugs: ["resume-parser"],
        },
      ],
    });
  });

  it("fails closed for pre-ledger provenance and omitted live Factory agents", () => {
    expect(() =>
      buildFactoryProductionRegressionInventory({
        deployments: deployments([
          factoryAgent({ factory_promotion_version_id: undefined }),
        ]),
        ledger: ledger(),
      }),
    ).toThrow("incomplete or non-production regression provenance");

    expect(() =>
      buildFactoryProductionRegressionInventory({
        deployments: deployments([factoryAgent({ id: "unrecorded-agent" })]),
        ledger: ledger(),
      }),
    ).toThrow("missing from the committed promotion ledger");
  });

  it("fails when the deployment anchor or high-watermark is inconsistent", () => {
    expect(() =>
      buildFactoryProductionRegressionInventory({
        deployments: deployments(),
        ledger: ledger([promotion({ deploymentId: "dpl-does-not-exist" })]),
      }),
    ).toThrow("not anchored to the matching production deployment inventory");

    const inconsistent = ledger();
    inconsistent.highWatermark = {
      ...inconsistent.highWatermark!,
      committedCount: 2,
    };
    expect(() =>
      buildFactoryProductionRegressionInventory({
        deployments: deployments(),
        ledger: inconsistent,
      }),
    ).toThrow("committed count does not match its high-watermark");
  });

  it("rejects an omitted rolled-back promotion deployment", () => {
    const historical = deployments();
    historical.push({
      ...historical[0]!,
      deploymentId: "dpl-omitted-history",
      note: "agent-factory-promotion:fpr-deadbeef",
    });
    expect(() =>
      buildFactoryProductionRegressionInventory({
        deployments: historical,
        ledger: ledger(),
      }),
    ).toThrow("deployment history is missing from the committed promotion ledger");
  });

  it("does not let an orphan deployment version disappear from reverse inventory", () => {
    const rows = deployments();
    rows[0] = { ...rows[0]!, workflowTenantId: null };
    expect(() =>
      buildFactoryProductionRegressionInventory({
        deployments: rows,
        ledger: ledger(),
      }),
    ).toThrow("orphan or cross-tenant version");
  });

  it("ignores non-workflow runtime deployment markers", () => {
    const rows = deployments();
    rows.push({
      deploymentId: "dpl-inngest-ten-inventory",
      tenantId,
      tenantSlug,
      workflowTenantId: null,
      target: "runtime",
      status: "live",
      note: "agentic-operator:tenant-inngest-selection:v1",
      manifest: null,
    });

    expect(
      buildFactoryProductionRegressionInventory({
        deployments: rows,
        ledger: ledger(),
      }).liveAgents,
    ).toHaveLength(1);
  });

  it("refuses pending and empty ledgers instead of reporting an empty pass", () => {
    const pending = ledger();
    pending.pending.push({
      file: "/withheld/pending.json",
      record: promotion({ deploymentId: undefined, committedAt: undefined }),
    });
    expect(() =>
      buildFactoryProductionRegressionInventory({
        deployments: deployments(),
        ledger: pending,
      }),
    ).toThrow("promotion ledger contains pending records");

    const empty = ledger([]);
    empty.highWatermark = undefined;
    empty.highWatermarkError = "missing";
    expect(() =>
      buildFactoryProductionRegressionInventory({
        deployments: [],
        ledger: empty,
      }),
    ).toThrow("promotion ledger high-watermark is missing or invalid");
  });
});
