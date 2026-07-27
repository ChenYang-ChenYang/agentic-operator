// OntoCode · 人工边界确认：当 Build 因某系统「无已授权工具/运行时能力」被 readiness
// 门拦下（catalog_readiness_requires_authoritative_input），FDE 可显式确认「这是人工
// 边界」。确认= 把该系统写成一条 governance.humanBoundary=true 的 System Profile（诚实、
// 持久、已有的 systemHumanBoundaries 端口每次 Build 都会读取），随后 resume 等待中的 Build。
// 下一次 Build：design 门对这些系统按 status:"human_boundary" 放行设计稿（沙箱/交付/晋升
// 仍然 fail-closed），从而真正走到 candidate_ready。
//
// 这修复了 task_7bfe6f64：设计门此前从不消费「确认人工边界」，导致引用未绑定系统的动作
// 永远出不了 spec、Build 永远拿不到 candidate。
import { and, desc, eq } from "drizzle-orm";
import {
  getDb,
  ontocodeHarnessJobs,
  ontocodeSessionEvents,
} from "@agentic/db";
import { upsertSystemProfile } from "./system-profile-store";
import {
  createOntoCodeTurn,
  getOntoCodeSession,
  makeOntoCodeIdempotencyKey,
  OntoCodeStoreError,
  type OntoCodeStoreContext,
} from "./ontocode-session-store";

const RESUME_ACTION_BY_KIND: Record<string, string> = {
  scope: "analyze_scope",
  blueprint: "propose_blueprint",
  build: "generate_package",
  test: "run_tests",
  debug: "debug_failure",
  regression: "compare_candidate",
};

/** System Profile id 必须是 kebab-case；原始系统名保留进 name/aliases 供门匹配。 */
function kebabId(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
  return /^[a-z]/.test(slug) ? slug : `sys-${slug}` || "system";
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** 从等待事件的结构化问题里读出 systems（服务端权威，绝不信客户端传入的清单）。 */
function boundarySystemsFromEvents(
  events: { payloadJson: string }[],
): string[] {
  for (const row of events) {
    let payload: unknown;
    try {
      payload = JSON.parse(row.payloadJson);
    } catch {
      continue;
    }
    if (!isRecord(payload) || !isRecord(payload.question)) continue;
    const systems = payload.question.systems;
    if (Array.isArray(systems)) {
      const named = systems.filter(
        (s): s is string => typeof s === "string" && s.trim().length > 0,
      );
      if (named.length > 0) return [...new Set(named.map((s) => s.trim()))];
    }
  }
  return [];
}

export interface ConfirmHumanBoundaryResult {
  systems: string[];
  markedProfiles: string[];
  resumed: boolean;
  resumeAction: string | null;
  waitingJobId: string;
}

/**
 * 确认当前等待中的 Build 阻塞里那些「未绑定系统」为人工边界，并 resume。
 * 服务端从等待事件读取系统清单——不接受客户端提交的系统列表。
 */
export function confirmSessionHumanBoundaries(
  ctx: OntoCodeStoreContext,
  sessionId: string,
  opts: { waitingJobId?: string; note?: string } = {},
): ConfirmHumanBoundaryResult {
  // tenant-scoped；不存在/跨租户会抛 OntoCodeStoreError(404)
  getOntoCodeSession(ctx, sessionId);
  const db = getDb();

  const jobRow = db
    .select()
    .from(ontocodeHarnessJobs)
    .where(
      and(
        eq(ontocodeHarnessJobs.tenantId, ctx.tenantId),
        eq(ontocodeHarnessJobs.sessionId, sessionId),
        opts.waitingJobId
          ? eq(ontocodeHarnessJobs.id, opts.waitingJobId)
          : eq(ontocodeHarnessJobs.status, "waiting_user"),
      ),
    )
    .orderBy(desc(ontocodeHarnessJobs.createdAt))
    .get();

  if (!jobRow || jobRow.status !== "waiting_user") {
    throw new OntoCodeStoreError(
      "ontocode_no_waiting_job",
      "当前没有等待人工边界确认的构建作业。",
      409,
    );
  }

  const events = db
    .select({ payloadJson: ontocodeSessionEvents.payloadJson })
    .from(ontocodeSessionEvents)
    .where(
      and(
        eq(ontocodeSessionEvents.tenantId, ctx.tenantId),
        eq(ontocodeSessionEvents.sessionId, sessionId),
        eq(ontocodeSessionEvents.harnessJobId, jobRow.id),
      ),
    )
    .orderBy(desc(ontocodeSessionEvents.seq))
    .all();

  const systems = boundarySystemsFromEvents(events);
  if (systems.length === 0) {
    throw new OntoCodeStoreError(
      "ontocode_no_boundary_systems",
      "该阻塞没有可确认为人工边界的系统；请改用「去配置」接入真实工具，或回复更新说明。",
      409,
    );
  }

  const markedProfiles: string[] = [];
  for (const system of systems) {
    const profile = upsertSystemProfile(
      ctx.tenantId,
      {
        id: kebabId(system),
        name: system,
        aliases: [system],
        availability: "planned",
        plannedFallback: "human_boundary",
        governance: {
          humanBoundary: true,
          notes:
            opts.note?.trim() ||
            `FDE 在 OntoCode 会话 ${sessionId} 确认为人工边界（设计稿可继续；执行/交付/晋升仍 fail-closed）。`,
        },
        provenance: { mode: "manual" },
      },
      { confirmedBy: ctx.actorId ?? undefined },
    );
    markedProfiles.push(profile.id);
  }

  const resumeAction = RESUME_ACTION_BY_KIND[jobRow.kind] ?? null;
  if (resumeAction) {
    createOntoCodeTurn(ctx, sessionId, {
      text: `确认人工边界：${systems.join("、")}。设计稿可继续；沙箱/交付/晋升仍会拦截。`,
      behavior: "execute",
      action: resumeAction as never,
      arguments: {
        clarificationAnswer: "确认人工边界",
        confirmedHumanBoundarySystems: systems,
        resumeWaitingUserJobId: jobRow.id,
        source: "human-boundary-confirmation",
      },
      affectedSemanticPaths: systems.map((s) => `system-boundary:${s}`),
      requestedCapabilities: [],
      idempotencyKey: makeOntoCodeIdempotencyKey(),
    });
  }

  return {
    systems,
    markedProfiles,
    resumed: Boolean(resumeAction),
    resumeAction,
    waitingJobId: jobRow.id,
  };
}
