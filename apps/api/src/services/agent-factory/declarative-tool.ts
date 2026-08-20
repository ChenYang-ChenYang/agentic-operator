// Declarative 造工具 LIBRARY helpers (persistence + listing for the /v1/tools endpoints).
//
// NOTE on layering: the RUNTIME EXECUTION of these tools — turning a factory_tools row into a
// runtime-invocable, SSRF-guarded ToolDescriptor and folding it into the per-step tenant tool map —
// lives in packages/tools (makeDeclarativeTool / buildDeclarativeOverlay) and is wired in
// packages/runtime/src/bootstrap.ts. THIS module is only the library-management surface: save (with
// a collision guard so a created tool can never shadow a real global tool), list (for the catalog),
// and tenant-scoped delete. All three operate on the same `factory_tools` table the overlay reads,
// so a tool authored here is browsable in the library AND runtime-callable (after the tenant builds).

import {
  isGeneratedToolExecutionPolicy,
  type DeclarativeTool,
} from "@agentic/agent-factory";
import { randomUUID } from "node:crypto";
import { globalToolRegistry } from "@agentic/tools";
import {
  and,
  eq,
  factoryToolRevisions,
  factoryTools,
  getDb,
} from "@agentic/db";
import {
  hasAnyFactoryActiveWork,
  hasFactoryActiveWork,
} from "./active-work";

type DbToolRow = typeof factoryTools.$inferSelect;

export class DeclarativeToolQueryError extends Error {
  constructor(cause: unknown) {
    super(
      "Failed to query persisted declarative tools; returning an empty catalog would hide a runtime storage outage",
      { cause },
    );
    this.name = "DeclarativeToolQueryError";
  }
}

export class DeclarativeToolDeleteError extends Error {
  constructor(cause: unknown) {
    super(
      "Failed to delete the persisted declarative tool; reporting not_found would hide a runtime storage outage",
      { cause },
    );
    this.name = "DeclarativeToolDeleteError";
  }
}

const domainKey = (domain: string | null | undefined): string => domain ?? "";

function toolRank(r: DbToolRow, tenantId: string | undefined, ontologyDomainId: string | null | undefined): number {
  const owner = tenantId && r.scopeKey === tenantId ? 20 : r.scopeKey === "shared" ? 10 : 0;
  const specificity = ontologyDomainId && r.domainKey === ontologyDomainId ? 2 : r.domainKey === "" ? 1 : 0;
  return owner + specificity;
}

function rowToDeclarativeTool(r: DbToolRow): DeclarativeTool {
  if (!isReviewedSideEffect(r.sideEffect)) {
    throw new DeclarativeToolQueryError(new Error(`tool ${r.name} has invalid side_effect metadata`));
  }
  const executionPolicy = {
    operation: r.operation,
    effectScope: r.effectScope,
    sandboxPolicy: r.sandboxPolicy,
  };
  if (!isGeneratedToolExecutionPolicy(executionPolicy)) {
    throw new DeclarativeToolQueryError(new Error(
      `tool ${r.name} requires explicit operation/effect_scope/sandbox_policy migration`,
    ));
  }
  return {
    name: r.name,
    description: r.description,
    method: r.method,
    urlTemplate: r.urlTemplate,
    headers: (r.headers as Record<string, string>) ?? undefined,
    bodyTemplate: r.bodyTemplate ?? undefined,
    requestSpec: (r.requestSpec as DeclarativeTool["requestSpec"]) ?? undefined,
    responseSpec: (r.responseSpec as DeclarativeTool["responseSpec"]) ?? undefined,
    examples: (r.examples as DeclarativeTool["examples"]) ?? undefined,
    sideEffect: r.sideEffect,
    ...executionPolicy,
    domain: r.domain,
    paramsSchema: (r.paramsSchema as Record<string, unknown>) ?? undefined,
    returnsSchema: (r.returnsSchema as Record<string, unknown>) ?? undefined,
    capabilities: (r.capabilities as DeclarativeTool["capabilities"]) ?? undefined,
    probeStatus: r.probeStatus as DeclarativeTool["probeStatus"],
    definitionHash: r.definitionHash ?? undefined,
    probeEvidence: (r.probeEvidence as Record<string, unknown>) ?? undefined,
    verifiedAt: r.verifiedAt?.toISOString(),
  };
}

function isReviewedSideEffect(value: unknown): value is "read" | "write" | "dual" {
  return value === "read" || value === "write" || value === "dual";
}

/** List persisted declarative tools for the catalog: the SHARED ones + the given tenant's own.
 *  `domainId` (optional) additionally scopes to the currently BOUND ontology domain: domainKey=""
 *  means explicitly general (always visible); a non-empty domainKey is only visible while that
 *  domain is bound — a rebind must not surface the previous ontology's same-named tools.
 *  `undefined` = no domain filter (back-compat for pre-binding callers). */
export function listDeclarativeTools(tenantId?: string, domainId?: string | null): DeclarativeTool[] {
  let rows: DbToolRow[];
  try {
    rows = getDb().select().from(factoryTools).all();
  } catch (err) {
    throw new DeclarativeToolQueryError(err);
  }
  const visible = rows
    .filter((r) => r.scopeKey === "shared" || (!!tenantId && r.scopeKey === tenantId))
    .filter((r) => domainId === undefined || r.domainKey === "" || (domainId != null && r.domainKey === domainId));
  // Management callers that intentionally omit a binding receive every row,
  // including same-name rows from different ontology domains.
  if (domainId === undefined) return visible.map(rowToDeclarativeTool);
  const selected = new Map<string, DbToolRow>();
  for (const row of visible
    .sort((a, b) => toolRank(b, tenantId, domainId) - toolRank(a, tenantId, domainId))) {
    if (!selected.has(row.name)) selected.set(row.name, row);
  }
  return [...selected.values()].map(rowToDeclarativeTool);
}

/** Persist a declarative tool (standalone 造工具 endpoint). Refuses a name that collides with a
 *  built-in global tool (the runtime overlay would otherwise be un-shadowable). */
export function saveDeclarativeTool(
  dt: DeclarativeTool,
  scope?: { tenantId?: string; shared?: boolean },
): { ok: boolean; reason?: string } {
  if (!dt.name || !dt.name.trim()) return { ok: false, reason: "工具名不能为空" };
  if (globalToolRegistry.get(dt.name)) return { ok: false, reason: `「${dt.name}」与内置全局工具同名，请换个带命名空间的名字（如 acme.${dt.name}）` };
  if (!isReviewedSideEffect(dt.sideEffect)) {
    return { ok: false, reason: "side_effect 必须显式声明为 read、write 或 dual，缺失/未知值不能默认成只读" };
  }
  if (!isGeneratedToolExecutionPolicy(dt)) {
    return { ok: false, reason: "operation、effectScope、sandboxPolicy 必须完整且组合合法；历史 side_effect/HTTP method 不会被自动转换" };
  }
  const shared = scope?.shared === true || !scope?.tenantId;
  if (shared ? hasAnyFactoryActiveWork() : hasFactoryActiveWork(scope!.tenantId!)) {
    return {
      ok: false,
      reason: "FACTORY_EXECUTION_ACTIVE：沙箱验证、报告或 promotion 正在使用当前工具快照；本轮结束前不能替换工具定义。",
    };
  }
  try {
    const now = new Date();
    const scopeKey = shared ? "shared" : scope!.tenantId!;
    const cols = {
      scopeKey,
      domainKey: domainKey(dt.domain),
      tenantId: shared ? null : scope!.tenantId!,
      description: dt.description ?? "",
      method: (dt.method || "GET").toUpperCase(),
      urlTemplate: dt.urlTemplate ?? "",
      headers: dt.headers ?? null,
      bodyTemplate: dt.bodyTemplate ?? null,
      requestSpec: dt.requestSpec ?? null,
      responseSpec: dt.responseSpec ?? null,
      examples: dt.examples ?? null,
      sideEffect: dt.sideEffect,
      operation: dt.operation,
      effectScope: dt.effectScope,
      sandboxPolicy: dt.sandboxPolicy,
      domain: dt.domain ?? null,
      paramsSchema: dt.paramsSchema ?? null,
      returnsSchema: dt.returnsSchema ?? null,
      capabilities: dt.capabilities ?? null,
      probeStatus: dt.probeStatus ?? "required",
      definitionHash: dt.definitionHash ?? null,
      probeEvidence: dt.probeEvidence ?? null,
      verifiedAt: dt.verifiedAt ? new Date(dt.verifiedAt) : null,
    };
    getDb()
      .insert(factoryTools)
      .values({ id: `tol-${randomUUID()}`, name: dt.name, ...cols, createdAt: now, updatedAt: now })
      .onConflictDoUpdate({ target: [factoryTools.scopeKey, factoryTools.domainKey, factoryTools.name], set: { ...cols, updatedAt: now } })
      .run();
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }
}

/** Delete a created tool by name. TENANT-ISOLATED: a tenant may delete a SHARED tool or one of its
 *  OWN domain-scoped tools, but NOT another tenant's domain-scoped tool. Returns false if not found
 *  or out of scope. */
export function deleteDeclarativeTool(name: string, tenantId?: string, allowShared = false, domainId?: string | null): boolean {
  try {
    let candidates = getDb().select().from(factoryTools).where(eq(factoryTools.name, name)).all();
    // Same domain scoping as listDeclarativeTools: with a bound domain you can only delete general
    // tools or tools authored under THAT domain — never another (unbound) ontology's tool.
    if (domainId !== undefined) candidates = candidates.filter((r) => r.domainKey === "" || (domainId != null && r.domainKey === domainId));
    const owned = candidates
      .filter((r) => (!!tenantId && r.scopeKey === tenantId) || (allowShared && r.scopeKey === "shared"))
      .sort((a, b) => toolRank(b, tenantId, domainId) - toolRank(a, tenantId, domainId));
    // Without a domain selector, deleting the first same-name row would be
    // nondeterministic and could erase a different ontology's implementation.
    if (domainId === undefined && owned.length > 1) return false;
    const row = owned[0];
    if (!row) return false;
    const managedActive = getDb()
      .select({
        id: factoryToolRevisions.id,
        domainKey: factoryToolRevisions.domainKey,
      })
      .from(factoryToolRevisions)
      .where(
        and(
          eq(factoryToolRevisions.tenantId, row.scopeKey),
          eq(factoryToolRevisions.name, row.name),
          eq(factoryToolRevisions.status, "active"),
        ),
      )
      .all()
      .find(
        (revision) =>
          revision.domainKey === row.domainKey ||
          (row.domainKey === "" && revision.domainKey === "__unbound__"),
      );
    if (managedActive) {
      throw new Error(
        `MANAGED_TOOL_REQUIRES_DEACTIVATION：active revision ${managedActive.id} 必须通过事务 deactivate 退役；legacy delete 不会破坏 ledger/projection 一致性。`,
      );
    }
    if (
      row.scopeKey === "shared"
        ? hasAnyFactoryActiveWork()
        : hasFactoryActiveWork(row.scopeKey)
    ) {
      throw new Error(
        "FACTORY_EXECUTION_ACTIVE：沙箱验证、报告或 promotion 正在使用当前工具快照；本轮结束前不能删除工具定义。",
      );
    }
    const res = getDb().delete(factoryTools).where(eq(factoryTools.id, row.id)).run() as { changes?: number };
    return (res?.changes ?? 0) > 0;
  } catch (error) {
    throw new DeclarativeToolDeleteError(error);
  }
}
