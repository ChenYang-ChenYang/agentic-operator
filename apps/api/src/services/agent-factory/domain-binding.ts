import { randomUUID } from "node:crypto";
import {
  businessOntologyDomains,
  factoryDomainBindings,
  factoryRuns,
  getDb,
  ontocodeHarnessJobs,
  ontocodeSessions,
  eq,
  and,
  inArray,
} from "@agentic/db";
import { desc, isNull, ne } from "drizzle-orm";
import { hasFactoryActiveWork } from "./active-work";

export interface FactoryDomainBinding {
  tenantId: string;
  ontologyDomainId: string;
  ontologyDomainName: string | null;
  source: "explicit" | "auto" | "upload";
  createdAt: string;
  updatedAt: string;
}

export interface OntologyDomainListItem {
  id: string;
  name?: string;
  counts?: Record<string, number>;
  source?: "allmeta" | "upload" | "manifest";
}

export class FactoryDomainBindingBlockedError extends Error {
  readonly code = "factory_running";

  constructor(
    message: string,
    readonly details: {
      blockerType: "factory_work" | "ontocode_session" | "ontocode_harness_job";
      blockerId?: string;
      sessionId?: string;
      status?: string;
    },
  ) {
    super(`factory_running: ${message}`);
    this.name = "FactoryDomainBindingBlockedError";
  }
}

const iso = (v: unknown): string =>
  v instanceof Date
    ? v.toISOString()
    : new Date(v as string | number).toISOString();

/** Used only for one-time auto-binding, never as an ongoing identity relation. */
export function migrationDomainKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .normalize("NFKC")
    .replace(/-v\d+(?:\.\d+)*$/i, "")
    .replace(/[\s_-]+/g, "");
}

function rowToBinding(
  row: typeof factoryDomainBindings.$inferSelect,
): FactoryDomainBinding {
  return {
    tenantId: row.tenantId,
    ontologyDomainId: row.ontologyDomainId,
    ontologyDomainName: row.ontologyDomainName ?? null,
    source: row.source as FactoryDomainBinding["source"],
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

export function getFactoryDomainBinding(
  tenantId: string,
): FactoryDomainBinding | null {
  const row = getDb()
    .select()
    .from(factoryDomainBindings)
    .where(eq(factoryDomainBindings.tenantId, tenantId))
    .all()[0];
  return row ? rowToBinding(row) : null;
}

function findOpenOntoCodeWork(
  tx: Parameters<Parameters<ReturnType<typeof getDb>["transaction"]>[0]>[0],
  tenantId: string,
): {
  blockerType: "ontocode_session" | "ontocode_harness_job";
  blockerId: string;
  sessionId: string;
  status: string;
} | null {
  const openSession = tx
    .select({
      id: ontocodeSessions.id,
      phase: ontocodeSessions.phase,
      activityState: ontocodeSessions.activityState,
    })
    .from(ontocodeSessions)
    .where(
      and(
        eq(ontocodeSessions.tenantId, tenantId),
        ne(ontocodeSessions.phase, "completed"),
        ne(ontocodeSessions.activityState, "cancelled"),
      ),
    )
    .orderBy(desc(ontocodeSessions.updatedAt))
    .limit(1)
    .get();
  if (openSession) {
    return {
      blockerType: "ontocode_session",
      blockerId: openSession.id,
      sessionId: openSession.id,
      status: `${openSession.phase}:${openSession.activityState}`,
    };
  }

  const harnessJob = tx
    .select({
      id: ontocodeHarnessJobs.id,
      sessionId: ontocodeHarnessJobs.sessionId,
      status: ontocodeHarnessJobs.status,
    })
    .from(ontocodeHarnessJobs)
    .where(
      and(
        eq(ontocodeHarnessJobs.tenantId, tenantId),
        inArray(ontocodeHarnessJobs.status, [
          "queued",
          "leased",
          "running",
          "waiting_user",
          "retry_scheduled",
        ]),
      ),
    )
    .orderBy(desc(ontocodeHarnessJobs.updatedAt))
    .limit(1)
    .get();
  return harnessJob
    ? {
        blockerType: "ontocode_harness_job",
        blockerId: harnessJob.id,
        sessionId: harnessJob.sessionId,
        status: harnessJob.status,
      }
    : null;
}

export function setFactoryDomainBinding(
  tenantId: string,
  domain: { id: string; name?: string },
  source: FactoryDomainBinding["source"] = "explicit",
): FactoryDomainBinding {
  const now = new Date();
  const db = getDb();
  db.transaction((tx) => {
    const current = tx
      .select()
      .from(factoryDomainBindings)
      .where(eq(factoryDomainBindings.tenantId, tenantId))
      .all()[0];
    const changesIdentity =
      !current ||
      current.ontologyDomainId !== domain.id ||
      current.source !== source;
    const ontocodeBlocker = changesIdentity
      ? findOpenOntoCodeWork(tx, tenantId)
      : null;
    const unfinished = tx
      .select({ id: factoryRuns.id, status: factoryRuns.status })
      .from(factoryRuns)
      .where(
        and(
          eq(factoryRuns.tenantId, tenantId),
          inArray(factoryRuns.status, ["running", "waiting_human"]),
          isNull(factoryRuns.deletedAt),
        ),
      )
      .limit(1)
      .all()[0];
    if (changesIdentity && (unfinished || hasFactoryActiveWork(tenantId))) {
      throw new FactoryDomainBindingBlockedError(
        "当前业务领域仍有 Agent 工厂任务运行中或等待人工回复，不能更换本体连接",
        {
          blockerType: "factory_work",
          ...(unfinished
            ? { blockerId: unfinished.id, status: unfinished.status }
            : {}),
        },
      );
    }
    if (ontocodeBlocker) {
      throw new FactoryDomainBindingBlockedError(
        "OntoCode 协作任务未结束；请先完成或退役对应 Session，再更换本体连接",
        ontocodeBlocker,
      );
    }
    tx.insert(factoryDomainBindings)
      .values({
        tenantId,
        ontologyDomainId: domain.id,
        ontologyDomainName: domain.name ?? domain.id,
        source,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: factoryDomainBindings.tenantId,
        set: {
          ontologyDomainId: domain.id,
          ontologyDomainName: domain.name ?? domain.id,
          source,
          updatedAt: now,
        },
      })
      .run();
    const registrationSource =
      source === "explicit"
        ? "allmeta"
        : source === "upload"
          ? "upload"
          : "manifest_legacy";
    tx.update(businessOntologyDomains)
      .set({ isDefault: false, updatedAt: now })
      .where(eq(businessOntologyDomains.tenantId, tenantId))
      .run();
    tx.insert(businessOntologyDomains)
      .values({
        id: `bod-${randomUUID().replaceAll("-", "").slice(0, 16)}`,
        tenantId,
        ontologyDomainId: domain.id,
        displayName: domain.name ?? domain.id,
        source: registrationSource,
        status: "active",
        isDefault: true,
        catalogMetadataJson: JSON.stringify({
          synchronizedFrom: "factory_domain_bindings",
        }),
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          businessOntologyDomains.tenantId,
          businessOntologyDomains.source,
          businessOntologyDomains.ontologyDomainId,
        ],
        set: {
          displayName: domain.name ?? domain.id,
          status: "active",
          isDefault: true,
          archivedAt: null,
          updatedAt: now,
        },
      })
      .run();
  });
  return getFactoryDomainBinding(tenantId)!;
}

export function clearFactoryDomainBinding(tenantId: string): boolean {
  const db = getDb();
  return db.transaction((tx) => {
    const ontocodeBlocker = findOpenOntoCodeWork(tx, tenantId);
    const unfinished = tx
      .select({ id: factoryRuns.id, status: factoryRuns.status })
      .from(factoryRuns)
      .where(
        and(
          eq(factoryRuns.tenantId, tenantId),
          inArray(factoryRuns.status, ["running", "waiting_human"]),
          isNull(factoryRuns.deletedAt),
        ),
      )
      .limit(1)
      .all()[0];
    if (unfinished || hasFactoryActiveWork(tenantId)) {
      throw new FactoryDomainBindingBlockedError(
        "当前业务领域仍有 Agent 工厂任务运行中或等待人工回复，不能断开本体连接",
        {
          blockerType: "factory_work",
          ...(unfinished
            ? { blockerId: unfinished.id, status: unfinished.status }
            : {}),
        },
      );
    }
    if (ontocodeBlocker) {
      throw new FactoryDomainBindingBlockedError(
        "OntoCode 协作任务未结束；请先完成或退役对应 Session，再断开本体连接",
        ontocodeBlocker,
      );
    }
    const result = tx
      .delete(factoryDomainBindings)
      .where(eq(factoryDomainBindings.tenantId, tenantId))
      .run() as { changes?: number };
    tx.update(businessOntologyDomains)
      .set({ isDefault: false, updatedAt: new Date() })
      .where(eq(businessOntologyDomains.tenantId, tenantId))
      .run();
    return (result.changes ?? 0) > 0;
  });
}

export function catalogDomain(
  domains: OntologyDomainListItem[],
  requestedId: string,
): OntologyDomainListItem | null {
  const folded = requestedId.trim().toLowerCase().normalize("NFKC");
  const exact = domains.find((d) => d.id === requestedId);
  if (exact) return exact;
  const foldedMatches = domains.filter(
    (d) => d.id.trim().toLowerCase().normalize("NFKC") === folded,
  );
  // Case-folding is convenience, not identity. If the catalog contains two
  // distinct ids that fold to the same value, choosing the first would bind a
  // tenant nondeterministically; require an exact id instead.
  return foldedMatches.length === 1 ? foldedMatches[0]! : null;
}

export function bindingMatchesDomain(
  binding: FactoryDomainBinding | null,
  domainId: string,
): boolean {
  return !!binding && binding.ontologyDomainId === domainId;
}
