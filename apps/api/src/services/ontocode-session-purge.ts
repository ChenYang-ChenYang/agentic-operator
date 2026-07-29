// #SESSION-PURGE —— 删除一个 OntoCode Session 时，真正要删掉的是什么。
//
// 问题的准确形状：一个 Session 的持久足迹横跨四个存储，而一次行删除只够得着
// 其中一个。
//
//   1. SQLite 行 —— 20 张 ontocode 表的 session 外键全部 cascade，这部分本来
//      就是对的（已逐表核过）。
//   2. data/logs/factory-runs/<tenantId>/ocf-<jobId>-a<n>.ndjson —— 大脑完整
//      事件流，一个域十几 MB。
//   3. data/factory-conversation-archive/_tenants/<tenantId>/<domain>/<runId>.ndjson
//      —— 压缩归档。`recall_conversation` 搜的就是它：只删行的话，一个用户
//      以为已经抹掉的 Session，之后仍然能被检索出内容。这是隐私问题，不是
//      磁盘占用问题。
//   4. ontocode_artifact_blobs —— 内容寻址、按 tenant 去重，`content_text` 里
//      是产物正文，且【没有】session 外键，所以 Session 删掉后正文原样留库。
//
// 结构上的陷阱：上面每个文件都按【作业 id】命名，而作业行是把文件映射回
// Session 的唯一线索——cascade 恰恰先删作业行。所以任何没有在删行【之前】采集
// 下来的东西，从那一刻起永久不可归属，只能当垃圾留着。
//
// 因此删除必须是四拍，顺序不能换：
//     采集（行还在）→ 落记录 → 删行 → 清外部 → 结算
// 中间任何一步崩掉，留下的是一条 status=pending、targets 明确的记录，可以重试
// 补完；而不是一堆没人知道属于谁的文件。
import { createHash } from "node:crypto";
import { readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { eq, inArray } from "drizzle-orm";
import {
  getDb,
  ontocodeArtifactBlobs,
  ontocodeArtifacts,
  ontocodeArtifactVersions,
  ontocodeEvidenceRecords,
  ontocodeHarnessJobs,
  ontocodeProjects,
  ontocodeSessionEvents,
  ontocodeSessionMessages,
  ontocodeSessionPurges,
  ontocodeSessions,
  tenantScope,
} from "@agentic/db";

export type OntoCodePurgeTargetKind =
  | "factory_run_transcript"
  | "conversation_archive"
  | "artifact_blob";

export interface OntoCodePurgeTarget {
  kind: OntoCodePurgeTargetKind;
  /** 绝对路径（文件类），或 blob 行 id。 */
  ref: string;
  /** 采集时的字节数；未知为 null。 */
  bytes: number | null;
  /** 这个目标是被哪个作业/Session 牵出来的——留证据，便于事后解释。 */
  via: string;
}

export interface OntoCodeSessionRetention {
  what: string;
  why: string;
}

export interface OntoCodeSessionFootprint {
  sessionId: string;
  sessionTitle: string;
  projectId: string;
  domain: string;
  /** Session 曾经是什么——行删掉之后这就是唯一的记录。 */
  summary: {
    phase: string;
    activityState: string;
    goal: string | null;
    createdAt: number;
    jobs: number;
    jobIds: string[];
    messages: number;
    events: number;
    artifacts: number;
    artifactVersions: number;
    evidence: number;
  };
  targets: OntoCodePurgeTarget[];
  /** 刻意不删的东西 + 理由。删除必须说清自己没删什么。 */
  retained: OntoCodeSessionRetention[];
}

function dataRoot(): string {
  return process.env.AGENTIC_DATA_ROOT?.trim() || "./data";
}

/** 与各存储自身的落盘规则一致：id 是不透明字符串，绝不让它逃出目录。 */
function safeSegment(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^\.+/, "_");
  return cleaned.slice(0, 200) || "_";
}

async function fileBytes(file: string): Promise<number | null> {
  try {
    return (await stat(file)).size;
  } catch {
    return null;
  }
}

async function listIfPresent(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

/** `ocf-<jobId>-a<attempt>.ndjson` → jobId，不匹配返回 null。 */
function jobIdOfRunFile(fileName: string): string | null {
  return /^ocf-(ocj-[A-Za-z0-9]+)-a\d+\.ndjson$/.exec(fileName)?.[1] ?? null;
}

/**
 * 采集一个 Session 的全部外部足迹。**必须在删行之前调用** —— 之后作业行没了，
 * 文件名里的作业 id 再也对不回任何 Session。
 *
 * 纯只读：不删、不写。
 */
export async function collectOntoCodeSessionFootprint(
  ctx: { tenantId: string },
  sessionId: string,
): Promise<OntoCodeSessionFootprint | null> {
  const db = getDb();
  const session = db
    .select()
    .from(ontocodeSessions)
    .where(
      tenantScope(ctx, ontocodeSessions)(eq(ontocodeSessions.id, sessionId)),
    )
    .get();
  if (!session) return null;

  const project = db
    .select({ domain: ontocodeProjects.domain })
    .from(ontocodeProjects)
    .where(
      tenantScope(ctx, ontocodeProjects)(eq(ontocodeProjects.id, session.projectId)),
    )
    .get();
  const domain = project?.domain ?? "";

  const jobs = db
    .select({ id: ontocodeHarnessJobs.id })
    .from(ontocodeHarnessJobs)
    .where(
      tenantScope(
        ctx,
        ontocodeHarnessJobs,
      )(eq(ontocodeHarnessJobs.sessionId, sessionId)),
    )
    .all();
  const jobIds = new Set(jobs.map((job) => job.id));

  const targets: OntoCodePurgeTarget[] = [];

  // ── 2：工厂运行转录 ────────────────────────────────────────────────────
  //
  // attempt 会随重试递增而作业行只留当前值，所以按前缀扫目录、而不是按已知
  // attempt 拼名字——猜漏一个就是永久留一份没人读得懂的转录。
  const transcriptDir = path.resolve(
    dataRoot(),
    "logs",
    "factory-runs",
    safeSegment(session.tenantId),
  );
  for (const name of await listIfPresent(transcriptDir)) {
    const via = jobIdOfRunFile(name);
    if (!via || !jobIds.has(via)) continue;
    const file = path.join(transcriptDir, name);
    targets.push({
      kind: "factory_run_transcript",
      ref: file,
      bytes: await fileBytes(file),
      via,
    });
  }

  // ── 3：压缩归档（recall_conversation 的检索面） ─────────────────────────
  //
  // 归档按 <tenantId>/<domain> 分目录。这里扫租户下所有域目录而不是只扫本域：
  // 域名段经过 safeSegment，历史上也可能换过写法，只扫一个目录会漏。文件名里的
  // 作业 id 才是权威判据。
  const archiveRoot = path.join(
    dataRoot(),
    "factory-conversation-archive",
    "_tenants",
    safeSegment(session.tenantId),
  );
  for (const domainDir of await listIfPresent(archiveRoot)) {
    const dir = path.join(archiveRoot, domainDir);
    for (const name of await listIfPresent(dir)) {
      const via = jobIdOfRunFile(name);
      if (!via || !jobIds.has(via)) continue;
      const file = path.join(dir, name);
      targets.push({
        kind: "conversation_archive",
        ref: file,
        bytes: await fileBytes(file),
        via,
      });
    }
  }

  // ── 4：产物 blob ──────────────────────────────────────────────────────
  //
  // blob 内容寻址、按 tenant 去重，可能被别的 Session 的产物版本共享。只采集
  // 【删掉本 Session 之后再无引用】的那些：其余保留是正确的，删掉会毁掉别人的
  // 产物。判据是「该 blob 的全部引用都来自本 Session」。
  const versionRows = db
    .select({
      blobId: ontocodeArtifactVersions.blobId,
      sessionId: ontocodeArtifactVersions.sessionId,
    })
    .from(ontocodeArtifactVersions)
    .where(tenantScope(ctx, ontocodeArtifactVersions)(undefined))
    .all();
  const ownersByBlob = new Map<string, Set<string>>();
  for (const row of versionRows) {
    if (!row.blobId) continue;
    const owners = ownersByBlob.get(row.blobId) ?? new Set<string>();
    owners.add(row.sessionId);
    ownersByBlob.set(row.blobId, owners);
  }
  const soleOwned = [...ownersByBlob.entries()]
    .filter(([, owners]) => owners.size === 1 && owners.has(sessionId))
    .map(([blobId]) => blobId);
  if (soleOwned.length > 0) {
    for (const blob of db
      .select({
        id: ontocodeArtifactBlobs.id,
        sizeBytes: ontocodeArtifactBlobs.sizeBytes,
      })
      .from(ontocodeArtifactBlobs)
      .where(
        tenantScope(
          ctx,
          ontocodeArtifactBlobs,
        )(inArray(ontocodeArtifactBlobs.id, soleOwned)),
      )
      .all()) {
      targets.push({
        kind: "artifact_blob",
        ref: blob.id,
        bytes: blob.sizeBytes,
        via: sessionId,
      });
    }
  }

  const count = (rows: unknown[]): number => rows.length;
  const messages = count(
    db
      .select({ id: ontocodeSessionMessages.id })
      .from(ontocodeSessionMessages)
      .where(
        tenantScope(
          ctx,
          ontocodeSessionMessages,
        )(eq(ontocodeSessionMessages.sessionId, sessionId)),
      )
      .all(),
  );
  const events = count(
    db
      .select({ id: ontocodeSessionEvents.id })
      .from(ontocodeSessionEvents)
      .where(
        tenantScope(
          ctx,
          ontocodeSessionEvents,
        )(eq(ontocodeSessionEvents.sessionId, sessionId)),
      )
      .all(),
  );
  const artifacts = count(
    db
      .select({ id: ontocodeArtifacts.id })
      .from(ontocodeArtifacts)
      .where(
        tenantScope(
          ctx,
          ontocodeArtifacts,
        )(eq(ontocodeArtifacts.sessionId, sessionId)),
      )
      .all(),
  );
  const artifactVersions = versionRows.filter(
    (row) => row.sessionId === sessionId,
  ).length;
  const evidence = count(
    db
      .select({ id: ontocodeEvidenceRecords.id })
      .from(ontocodeEvidenceRecords)
      .where(
        tenantScope(
          ctx,
          ontocodeEvidenceRecords,
        )(eq(ontocodeEvidenceRecords.sessionId, sessionId)),
      )
      .all(),
  );

  return {
    sessionId,
    sessionTitle: session.title,
    projectId: session.projectId,
    domain,
    summary: {
      phase: session.phase,
      activityState: session.activityState,
      goal: session.goal ?? null,
      createdAt:
        session.createdAt instanceof Date
          ? session.createdAt.getTime()
          : Number(session.createdAt ?? 0),
      jobs: jobs.length,
      jobIds: [...jobIds],
      messages,
      events,
      artifacts,
      artifactVersions,
      evidence,
    },
    targets,
    retained: await describeRetention(ctx, session.tenantId, domain, sessionId),
  };
}

/**
 * 刻意保留的东西。删除如果不说清自己【没】删什么，用户就只能靠猜——而这恰恰是
 * 「无法真正删除」这个印象的来源。
 */
async function describeRetention(
  ctx: { tenantId: string },
  tenantId: string,
  domain: string,
  sessionId: string,
): Promise<OntoCodeSessionRetention[]> {
  const retained: OntoCodeSessionRetention[] = [
    {
      what: "审计记录（ontocode.session.deleted）",
      why: "删除本身要可追溯。审计行只记谁在何时删了哪个 Session，不含会话内容。",
    },
    {
      what: "本次清除记录（ontocode_session_purges）",
      why: "它是这个 Session 曾经存在过的唯一凭证，也是清理失败时的重试清单。",
    },
  ];

  // 生成的 agent 草稿按【域】分目录，同域多个 Session 共用一棵树，所以删一个
  // Session 不能删它——那会毁掉同域其它 Session 的产出。如实报数，不假装删净。
  const digest = createHash("sha256").update(domain).digest("hex").slice(0, 16);
  const draftDir = path.join(
    dataRoot(),
    "factory-drafts",
    "_tenants",
    safeSegment(tenantId),
    `${safeSegment(domain)}-${digest}`,
  );
  const versions = await listIfPresent(path.join(draftDir, "versions"));
  if (versions.length > 0) {
    retained.push({
      what: `生成的 agent 草稿 ${versions.length} 个版本（${draftDir}）`,
      why: "草稿按域存放、同域多个 Session 共用；按 Session 删会毁掉同域其它 Session 的产出。要清空请在域层面操作。",
    });
  }

  const sharedBlobs = getDb()
    .select({
      blobId: ontocodeArtifactVersions.blobId,
      sessionId: ontocodeArtifactVersions.sessionId,
    })
    .from(ontocodeArtifactVersions)
    .where(tenantScope(ctx, ontocodeArtifactVersions)(undefined))
    .all();
  const owners = new Map<string, Set<string>>();
  for (const row of sharedBlobs) {
    if (!row.blobId) continue;
    const set = owners.get(row.blobId) ?? new Set<string>();
    set.add(row.sessionId);
    owners.set(row.blobId, set);
  }
  const shared = [...owners.values()].filter(
    (set) => set.has(sessionId) && set.size > 1,
  ).length;
  if (shared > 0) {
    retained.push({
      what: `与其它 Session 共享的产物内容 ${shared} 份`,
      why: "内容寻址去重：同样的字节被别的 Session 也引用着，删掉会毁掉它们的产物。",
    });
  }
  return retained;
}

export interface OntoCodePurgeResult {
  purgeId: string;
  status: "completed" | "partial";
  removed: Array<{ kind: OntoCodePurgeTargetKind; ref: string; bytes: number }>;
  failures: Array<{ kind: OntoCodePurgeTargetKind; ref: string; error: string }>;
  bytesRemoved: number;
}

/** 记录一次待执行的清除。**在删行之前调用**，这样崩溃也留得下工单。 */
export function recordOntoCodeSessionPurge(
  ctx: { tenantId: string; actorId?: string | null },
  footprint: OntoCodeSessionFootprint,
  purgeId: string,
): void {
  const now = new Date();
  getDb()
    .insert(ontocodeSessionPurges)
    .values({
      id: purgeId,
      tenantId: ctx.tenantId,
      sessionId: footprint.sessionId,
      sessionTitle: footprint.sessionTitle,
      projectId: footprint.projectId,
      domain: footprint.domain,
      status: "pending",
      requestedBy: ctx.actorId ?? null,
      summaryJson: JSON.stringify({
        ...footprint.summary,
        retained: footprint.retained,
      }),
      targetsJson: JSON.stringify(footprint.targets),
      removedJson: "[]",
      failuresJson: "[]",
      bytesRemoved: 0,
      attempts: 0,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      // 同一个 Session 被重复删（重试路径）时更新工单，而不是撞唯一索引报错。
      target: [ontocodeSessionPurges.tenantId, ontocodeSessionPurges.sessionId],
      set: {
        status: "pending",
        targetsJson: JSON.stringify(footprint.targets),
        updatedAt: now,
      },
    })
    .run();
}

/**
 * 执行采集好的清单。文件级失败不抛——记进 failures，整条记录标 partial 可重试。
 * 一条清理失败绝不能把「Session 已删」这个既成事实变成错误。
 */
export async function purgeCollectedTargets(
  ctx: { tenantId: string },
  purgeId: string,
  targets: readonly OntoCodePurgeTarget[],
): Promise<OntoCodePurgeResult> {
  const removed: OntoCodePurgeResult["removed"] = [];
  const failures: OntoCodePurgeResult["failures"] = [];
  let bytesRemoved = 0;

  for (const target of targets) {
    try {
      if (target.kind === "artifact_blob") {
        getDb()
          .delete(ontocodeArtifactBlobs)
          .where(
            tenantScope(
              ctx,
              ontocodeArtifactBlobs,
            )(eq(ontocodeArtifactBlobs.id, target.ref)),
          )
          .run();
      } else {
        // force:true —— 已经不在了也算成功（重试路径要幂等）。
        await rm(target.ref, { force: true });
      }
      const bytes = target.bytes ?? 0;
      bytesRemoved += bytes;
      removed.push({ kind: target.kind, ref: target.ref, bytes });
    } catch (error) {
      failures.push({
        kind: target.kind,
        ref: target.ref,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const status: OntoCodePurgeResult["status"] =
    failures.length === 0 ? "completed" : "partial";
  const now = new Date();
  const current = getDb()
    .select({ attempts: ontocodeSessionPurges.attempts })
    .from(ontocodeSessionPurges)
    .where(
      tenantScope(
        ctx,
        ontocodeSessionPurges,
      )(eq(ontocodeSessionPurges.id, purgeId)),
    )
    .get();
  getDb()
    .update(ontocodeSessionPurges)
    .set({
      status,
      removedJson: JSON.stringify(removed),
      failuresJson: JSON.stringify(failures),
      bytesRemoved,
      attempts: (current?.attempts ?? 0) + 1,
      updatedAt: now,
      ...(status === "completed" ? { completedAt: now } : {}),
    })
    .where(
      tenantScope(
        ctx,
        ontocodeSessionPurges,
      )(eq(ontocodeSessionPurges.id, purgeId)),
    )
    .run();

  return { purgeId, status, removed, failures, bytesRemoved };
}

export interface OntoCodeSessionPurgeRecord {
  id: string;
  sessionId: string;
  sessionTitle: string;
  domain: string;
  status: "pending" | "completed" | "partial";
  bytesRemoved: number;
  attempts: number;
  createdAt: number;
  completedAt: number | null;
  summary: Record<string, unknown>;
  targets: OntoCodePurgeTarget[];
  removed: OntoCodePurgeResult["removed"];
  failures: OntoCodePurgeResult["failures"];
}

function parseJson<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function listOntoCodeSessionPurges(
  ctx: { tenantId: string },
  opts: { status?: "pending" | "completed" | "partial"; limit?: number } = {},
): OntoCodeSessionPurgeRecord[] {
  const rows = getDb()
    .select()
    .from(ontocodeSessionPurges)
    .where(
      tenantScope(
        ctx,
        ontocodeSessionPurges,
      )(opts.status ? eq(ontocodeSessionPurges.status, opts.status) : undefined),
    )
    .all()
    .slice(0, opts.limit ?? 50);
  return rows.map((row) => ({
    id: row.id,
    sessionId: row.sessionId,
    sessionTitle: row.sessionTitle,
    domain: row.domain,
    status: row.status,
    bytesRemoved: row.bytesRemoved,
    attempts: row.attempts,
    createdAt:
      row.createdAt instanceof Date
        ? row.createdAt.getTime()
        : Number(row.createdAt ?? 0),
    completedAt:
      row.completedAt instanceof Date
        ? row.completedAt.getTime()
        : row.completedAt
          ? Number(row.completedAt)
          : null,
    summary: parseJson<Record<string, unknown>>(row.summaryJson, {}),
    targets: parseJson<OntoCodePurgeTarget[]>(row.targetsJson, []),
    removed: parseJson<OntoCodePurgeResult["removed"]>(row.removedJson, []),
    failures: parseJson<OntoCodePurgeResult["failures"]>(row.failuresJson, []),
  }));
}

/**
 * 把没清干净的重新清一遍。幂等：已经不在的目标按成功处理。
 * 这是「pending/partial 记录」存在的理由——否则一次瞬时失败就永久留下孤儿。
 */
export async function retryOntoCodeSessionPurge(
  ctx: { tenantId: string },
  purgeId: string,
): Promise<OntoCodePurgeResult | null> {
  const row = getDb()
    .select()
    .from(ontocodeSessionPurges)
    .where(
      tenantScope(
        ctx,
        ontocodeSessionPurges,
      )(eq(ontocodeSessionPurges.id, purgeId)),
    )
    .get();
  if (!row) return null;
  if (row.status === "completed") {
    return {
      purgeId,
      status: "completed",
      removed: parseJson<OntoCodePurgeResult["removed"]>(row.removedJson, []),
      failures: [],
      bytesRemoved: row.bytesRemoved,
    };
  }
  const targets = parseJson<OntoCodePurgeTarget[]>(row.targetsJson, []);
  return purgeCollectedTargets(ctx, purgeId, targets);
}
