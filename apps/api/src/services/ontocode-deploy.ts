// OntoCode · deploy preflight.
//
// Today a promotion/deploy job dies with `executor_not_available` — an internal
// error that tells the FDE nothing. This turns that dead end into an answer:
// exactly which conditions a candidate has met, which it has not, and what to do
// about each one.
//
// It deliberately does NOT relax anything. The legacy promotion kernel
// (promoteDrafts) enforces ~20 fail-closed gates — signed external-runner
// execution receipts, a human HMAC review receipt, no-mock, whole-version-only
// promotion, production integration probes. Those exist because a promotion puts
// generated code in front of real systems. Preflight mirrors the subset it can
// evaluate cheaply and up front, so the FDE learns the blockers BEFORE a long job
// runs and fails deep inside the kernel.
//
// Honesty rule: a blocker is reported with the real reason. "We could not verify"
// is never rendered as "not required".
import { and, eq, sql } from "drizzle-orm";
import {
  getDb,
  ontocodeArtifactBlobs,
  ontocodeArtifactVersions,
  ontocodePackageVersions,
} from "@agentic/db";
import { listOntoCodeSandboxAttempts } from "./ontocode-sandbox-attempt-store";
import { getOntoCodeCandidateHead } from "./ontocode-candidate-store";
import {
  getOntoCodeSession,
  type OntoCodeStoreContext,
} from "./ontocode-session-store";

export interface DeployBlocker {
  code:
    | "no_candidate"
    | "candidate_not_verified"
    | "sandbox_not_qualified"
    | "no_sandbox_attempt"
    | "systems_unbound"
    | "factory_draft_unbound";
  detail: string;
  /** What the FDE can actually do next. Never "contact support". */
  remedy: string;
}

/** #DRAFT-BINDING — the on-disk Factory draft version this Candidate promotes.
 * Read back from the Candidate's own immutable artifact, never re-derived. */
export interface DeployDraftBinding {
  bound: boolean;
  draftVersionIds: string[];
  domain: string | null;
  unboundReason: string | null;
}

const DRAFT_BINDING_LOGICAL_NAME = "package/factory-draft.json";

function readDraftBinding(
  tenantId: string,
  artifactRefs: unknown,
): DeployDraftBinding | null {
  const refs = Array.isArray(artifactRefs)
    ? (artifactRefs as Array<Record<string, unknown>>)
    : [];
  const ref = refs.find(
    (entry) => entry.logicalName === DRAFT_BINDING_LOGICAL_NAME,
  );
  const artifactVersionId =
    typeof ref?.artifactVersionId === "string" ? ref.artifactVersionId : null;
  if (!artifactVersionId) return null;
  const version = getDb()
    .select()
    .from(ontocodeArtifactVersions)
    .where(
      and(
        eq(ontocodeArtifactVersions.tenantId, tenantId),
        eq(ontocodeArtifactVersions.id, artifactVersionId),
      ),
    )
    .get();
  if (!version) return null;
  const blob = getDb()
    .select()
    .from(ontocodeArtifactBlobs)
    .where(eq(ontocodeArtifactBlobs.id, version.blobId))
    .get();
  if (!blob) return null;
  try {
    const parsed = JSON.parse(blob.contentText) as Record<string, unknown>;
    return {
      bound: parsed.bound === true,
      draftVersionIds: Array.isArray(parsed.draftVersionIds)
        ? parsed.draftVersionIds.filter(
            (value): value is string => typeof value === "string",
          )
        : [],
      domain: typeof parsed.domain === "string" ? parsed.domain : null,
      unboundReason:
        typeof parsed.unboundReason === "string" ? parsed.unboundReason : null,
    };
  } catch {
    // A corrupt binding is an unbound binding — never a passing one.
    return null;
  }
}

export interface DeployPreflight {
  deployable: boolean;
  blockers: DeployBlocker[];
  candidate: {
    packageVersionId: string;
    headRevision: number;
    status: string;
  } | null;
  sandbox: {
    attemptId: string;
    qualification: string;
    isolationTier: string | null;
    executionOrigin: string | null;
  } | null;
  draftBinding: DeployDraftBinding | null;
}

/**
 * Evaluate whether this Session's candidate could legitimately be promoted.
 * Read-only and cheap: it never starts a job and never mutates state.
 */
export function preflightOntoCodeDeploy(
  ctx: OntoCodeStoreContext,
  sessionId: string,
): DeployPreflight {
  getOntoCodeSession(ctx, sessionId);
  const blockers: DeployBlocker[] = [];

  const { head, packageVersion } = getOntoCodeCandidateHead(ctx, sessionId);
  if (!head || !packageVersion) {
    blockers.push({
      code: "no_candidate",
      detail: "这个 Session 还没有生成候选包，没有可部署的内容。",
      remedy: "先完成一次成功的构建（生成 Agent 代码），再回到这里。",
    });
    return {
      deployable: false,
      blockers,
      candidate: null,
      sandbox: null,
      draftBinding: null,
    };
  }

  const candidate = {
    packageVersionId: packageVersion.id,
    headRevision: head.revision,
    status: packageVersion.status,
  };

  // A candidate that has not been verified against a sandbox is a draft, no
  // matter how complete it looks.
  if (packageVersion.status === "candidate_ready") {
    blockers.push({
      code: "candidate_not_verified",
      detail:
        "候选包只到 candidate_ready：代码已生成，但还没有通过沙箱验证，不能上线。",
      remedy: "先运行测试（沙箱验证）。通过后候选包才会升为 verified_candidate。",
    });
  }

  const attempts = listOntoCodeSandboxAttempts(ctx, sessionId, {
    limit: 20,
    offset: 0,
  });
  const latest = attempts.items[0] ?? null;
  const sandbox = latest
    ? {
        attemptId: latest.id,
        qualification: latest.qualification,
        isolationTier: latest.isolationTier ?? null,
        executionOrigin: latest.executionOrigin ?? null,
      }
    : null;

  if (!latest) {
    blockers.push({
      code: "no_sandbox_attempt",
      detail: "还没有任何沙箱执行记录，无法证明生成的代码真的跑得起来。",
      remedy: "先运行测试，让候选包在隔离沙箱里真实执行一次。",
    });
  } else if (latest.qualification !== "promotable") {
    // This is the honest hard stop today: a same-host runner cannot produce a
    // signed execution receipt that the promotion kernel will accept.
    blockers.push({
      code: "sandbox_not_qualified",
      detail: `最近一次沙箱执行的资格是 ${latest.qualification}（隔离等级 ${
        latest.isolationTier ?? "未知"
      }）。同主机沙箱只能用于诊断，不能作为上线证据。`,
      remedy:
        "部署到生产需要一个合格的独立沙箱运行器（独立容器主机/VM/受管远程 runner）。这是基础设施配置，不是代码问题。",
    });
  }

  // Promotion operates on an immutable on-disk draft version. Without a binding
  // that names exactly one, "deploy this candidate" has no unambiguous target.
  const draftBinding = readDraftBinding(
    ctx.tenantId,
    packageVersion.artifactRefs,
  );
  if (!draftBinding || !draftBinding.bound) {
    blockers.push({
      code: "factory_draft_unbound",
      detail:
        draftBinding?.unboundReason ??
        "候选包没有绑定到唯一的 Factory draft 版本，无法确定要促升哪一版代码。",
      remedy:
        "重新运行一次构建：新的候选包会把生成的每个 Agent 与磁盘上的 draft 版本一一绑定。",
    });
  }

  return {
    deployable: blockers.length === 0,
    blockers,
    candidate,
    sandbox,
    draftBinding,
  };
}

export interface ReleaseRecord {
  packageVersionId: string;
  dependencyRoot: string;
  draftVersionId: string;
  reviewReceiptId: string;
  deploymentId: string | null;
  promotedSlugs: string[];
  functionsRegistered: number;
  liveAgents: number;
  releasedAt: Date;
}

/**
 * #RELEASED — the only write path to `released`. It runs after the promotion
 * kernel has already made the code live, and it is guarded on the exact
 * candidate that was verified: a package whose dependency root moved, or which
 * never reached verified_candidate, is not the thing that was deployed, so the
 * write must not land. A caller that sees `false` should report the promotion
 * result and the drift, never silently claim a release.
 */
export function markOntoCodeCandidateReleased(
  ctx: OntoCodeStoreContext,
  record: ReleaseRecord,
): boolean {
  const update = getDb()
    .update(ontocodePackageVersions)
    .set({
      status: "released",
      validationJson: sql`json_set(
        ${ontocodePackageVersions.validationJson},
        '$.releaseEligible', json('true'),
        '$.releasedAt', ${record.releasedAt.toISOString()},
        '$.factoryDraftVersionId', ${record.draftVersionId},
        '$.reviewReceiptId', ${record.reviewReceiptId},
        '$.deploymentId', ${record.deploymentId ?? null},
        '$.functionsRegistered', ${record.functionsRegistered},
        '$.liveAgents', ${record.liveAgents}
      )`,
      updatedAt: record.releasedAt,
    })
    .where(
      and(
        eq(ontocodePackageVersions.tenantId, ctx.tenantId),
        eq(ontocodePackageVersions.id, record.packageVersionId),
        eq(ontocodePackageVersions.dependencyRoot, record.dependencyRoot),
        eq(ontocodePackageVersions.status, "verified_candidate"),
      ),
    )
    .run();
  return update.changes === 1;
}

/** One-line human summary for a receipt/message. */
export function summarizePreflight(preflight: DeployPreflight): string {
  if (preflight.deployable) {
    return "候选包满足上线前置条件，可以提交人工审核并部署。";
  }
  return `暂时不能上线：${preflight.blockers
    .map((b) => b.detail)
    .join(" ")}`;
}
