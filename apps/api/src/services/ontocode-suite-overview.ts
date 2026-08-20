import { and, asc, desc, eq, inArray } from "drizzle-orm";
import {
  getDb,
  ontocodeConfigurationTasks,
  ontocodeEvidenceRecords,
  ontocodeSandboxAttempts,
  tenantScope,
} from "@agentic/db";
import {
  OntoCodeSuiteOverviewSchema,
  type OntoCodeSuiteOverview,
  type OntoCodeSuiteOverviewAgent,
} from "@agentic/contracts";
import { getOntoCodeCandidateHead } from "./ontocode-candidate-store";
import {
  getOntoCodeSession,
  type OntoCodeStoreContext,
} from "./ontocode-session-store";

// The Harness worker records evidence as `harness_${job.kind}`; only these two
// kinds are test executions whose outcomes may be counted as test verdicts.
const TEST_EVIDENCE_KINDS = ["harness_test", "harness_regression"] as const;

// A configuration task still demands FDE work while it is open or verifying.
const OPEN_TASK_STATUSES = ["open", "verifying"] as const;

// A sandbox attempt that has not concluded yet keeps the suite "verifying".
const PENDING_ATTEMPT_STATUSES = new Set(["queued", "running"]);

/**
 * Attribution is honest-or-null: an evidence record counts for an Agent only
 * when its dependencySet or refs mention the Agent name (string containment).
 */
function evidenceMentionsAgent(
  row: { dependencySetJson: string; refsJson: string },
  agentName: string,
): boolean {
  return (
    row.dependencySetJson.includes(agentName) ||
    row.refsJson.includes(agentName)
  );
}

/**
 * Read-only aggregation of the session's exact Candidate into one per-Agent
 * suite overview. No rows are written and no state is derived speculatively:
 * every field traces back to a persisted fact or is null.
 */
export function getOntoCodeSuiteOverview(
  ctx: Pick<OntoCodeStoreContext, "tenantId">,
  sessionId: string,
): OntoCodeSuiteOverview {
  // Reuse the session store's tenant-scoped read so cross-tenant lookups fail
  // with the exact same ontocode_session_not_found contract.
  const session = getOntoCodeSession(ctx, sessionId);
  const db = getDb();

  // readiness.pendingConfig = number of open/verifying configuration tasks (session-level).
  const openTasks = db
    .select()
    .from(ontocodeConfigurationTasks)
    .where(
      tenantScope(
        ctx,
        ontocodeConfigurationTasks,
      )(
        and(
          eq(ontocodeConfigurationTasks.sessionId, sessionId),
          inArray(ontocodeConfigurationTasks.status, OPEN_TASK_STATUSES),
        ),
      ),
    )
    .orderBy(
      asc(ontocodeConfigurationTasks.createdAt),
      asc(ontocodeConfigurationTasks.id),
    )
    .all();

  const { head, packageVersion } = getOntoCodeCandidateHead(ctx, sessionId);
  if (!head || !packageVersion) {
    // No candidate head yet → empty overview; open tasks are still reported honestly.
    return OntoCodeSuiteOverviewSchema.parse({
      sessionId: session.id,
      candidate: null,
      agents: [],
      readiness: { ready: 0, pendingConfig: openTasks.length, verifying: 0 },
      generatedAt: Date.now(),
    } satisfies OntoCodeSuiteOverview);
  }

  // Test verdicts come only from still-valid harness test/regression evidence.
  const evidenceRows = db
    .select({
      outcome: ontocodeEvidenceRecords.outcome,
      dependencySetJson: ontocodeEvidenceRecords.dependencySetJson,
      refsJson: ontocodeEvidenceRecords.refsJson,
    })
    .from(ontocodeEvidenceRecords)
    .where(
      tenantScope(
        ctx,
        ontocodeEvidenceRecords,
      )(
        and(
          eq(ontocodeEvidenceRecords.sessionId, sessionId),
          eq(ontocodeEvidenceRecords.state, "valid"),
          inArray(ontocodeEvidenceRecords.kind, TEST_EVIDENCE_KINDS),
        ),
      ),
    )
    .all();

  // Qualification comes from the latest sandbox attempt on this exact
  // candidate package; an attempt covers every Agent in that package.
  const latestAttempt = db
    .select({
      status: ontocodeSandboxAttempts.status,
      qualification: ontocodeSandboxAttempts.qualification,
    })
    .from(ontocodeSandboxAttempts)
    .where(
      tenantScope(
        ctx,
        ontocodeSandboxAttempts,
      )(
        and(
          eq(ontocodeSandboxAttempts.sessionId, sessionId),
          eq(ontocodeSandboxAttempts.packageVersionId, head.packageVersionId),
        ),
      ),
    )
    .orderBy(
      desc(ontocodeSandboxAttempts.createdAt),
      desc(ontocodeSandboxAttempts.ordinal),
    )
    .limit(1)
    .get();

  const agents: OntoCodeSuiteOverviewAgent[] = Object.entries(
    packageVersion.executionOwners,
  )
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, executionOwner]) => {
      // An Agent's artifacts are the refs under agents/<name>/ (worker layout)
      // or any /<name>/ path segment; refs matching no Agent attach nowhere.
      const artifacts = packageVersion.artifactRefs
        .filter(
          (ref) =>
            ref.logicalName.startsWith(`agents/${name}/`) ||
            ref.logicalName.includes(`/${name}/`),
        )
        .map((ref) => ({
          artifactId: ref.artifactId,
          artifactVersionId: ref.artifactVersionId,
          kind: ref.kind,
          logicalName: ref.logicalName,
        }));

      // When no evidence mentions the Agent, attribution is impossible and
      // test stays null — totals are never copied onto unproven Agents.
      const mentioned = evidenceRows.filter((row) =>
        evidenceMentionsAgent(row, name),
      );
      let test: OntoCodeSuiteOverviewAgent["test"] = null;
      if (mentioned.length > 0) {
        const totals = { passed: 0, failed: 0, inconclusive: 0 };
        for (const row of mentioned) {
          if (row.outcome === "passed") totals.passed += 1;
          else if (row.outcome === "failed") totals.failed += 1;
          else if (row.outcome === "inconclusive") totals.inconclusive += 1;
          // "informational" evidence is deliberately not a test verdict.
        }
        test = totals;
      }

      // blocking = title of the first open task whose sourceActionName matches the Agent name.
      const blockingTask = openTasks.find(
        (task) => task.sourceActionName === name,
      );

      return {
        name,
        executionOwner,
        artifacts,
        test,
        qualification: latestAttempt?.qualification ?? null,
        blocking: blockingTask ? blockingTask.title.slice(0, 500) : null,
      };
    });

  // ready = Agents proven by a promotable sandbox attempt or by attributed all-green tests.
  const ready = agents.filter(
    (agent) =>
      agent.qualification === "promotable" ||
      (agent.test !== null &&
        agent.test.failed === 0 &&
        agent.test.passed > 0),
  ).length;

  // verifying = Agents covered by a still-pending (queued/running) sandbox attempt.
  const verifying =
    latestAttempt && PENDING_ATTEMPT_STATUSES.has(latestAttempt.status)
      ? agents.length
      : 0;

  return OntoCodeSuiteOverviewSchema.parse({
    sessionId: session.id,
    candidate: {
      packageVersionId: head.packageVersionId,
      headId: head.id,
      revision: head.revision,
      status: packageVersion.status,
    },
    agents,
    readiness: { ready, pendingConfig: openTasks.length, verifying },
    generatedAt: Date.now(),
  } satisfies OntoCodeSuiteOverview);
}
