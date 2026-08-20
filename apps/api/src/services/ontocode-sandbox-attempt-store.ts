import { randomUUID } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import {
  getDb,
  ontocodeHarnessJobs,
  ontocodePackageVersions,
  ontocodeSandboxAttempts,
  ontocodeSessions,
  tenantScope,
} from "@agentic/db";
import {
  OntoCodeSandboxAttemptSchema,
  type OntoCodeSandboxAttempt,
} from "@agentic/contracts";
import {
  sandboxCleanupReceiptIssues,
  sandboxExecutionReceiptIssues,
  sandboxModelUsageEvidenceIssues,
  sandboxRegistrationEvidenceIssues,
  type SandboxDeployResult,
} from "@agentic/agent-factory";
import { canonicalEvidenceJson } from "@agentic/shared";
import {
  getOntoCodeSession,
  OntoCodeStoreError,
  type OntoCodeStoreContext,
  type Page,
} from "./ontocode-session-store";
import { remoteSandboxResultWasAdapterVerified } from "./agent-factory/remote-sandbox-deployer";

function timestamp(value: Date | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const result = value instanceof Date ? value.getTime() : Number(value);
  if (!Number.isFinite(result)) {
    throw new OntoCodeStoreError(
      "ontocode_data_corrupt",
      "OntoCode SandboxAttempt row has an invalid timestamp",
      500,
    );
  }
  return result;
}

function parseJsonObject(
  value: string | null,
  field: string,
): Record<string, unknown> | null {
  if (value === null) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("not an object");
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new OntoCodeStoreError(
      "ontocode_data_corrupt",
      `OntoCode SandboxAttempt has invalid JSON in ${field}`,
      500,
    );
  }
}

function attemptFromRow(
  row: typeof ontocodeSandboxAttempts.$inferSelect,
): OntoCodeSandboxAttempt {
  return OntoCodeSandboxAttemptSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    projectId: row.projectId,
    sessionId: row.sessionId,
    harnessJobId: row.harnessJobId,
    ordinal: row.ordinal,
    packageVersionId: row.packageVersionId,
    dependencyRoot: row.dependencyRoot,
    ontologyHash: row.ontologyHash,
    testSuiteHash: row.testSuiteHash,
    environmentProfileVersionId: row.environmentProfileVersionId ?? null,
    factorySandboxAttemptId: row.factorySandboxAttemptId ?? null,
    candidateFingerprint: row.candidateFingerprint,
    bundleHash: row.bundleHash ?? null,
    status: row.status,
    qualification: row.qualification,
    executionOrigin: row.executionOrigin ?? null,
    isolationTier: row.isolationTier ?? null,
    appId: row.appId ?? null,
    sandboxTenantSlug: row.sandboxTenantSlug ?? null,
    registrationReceipt: parseJsonObject(
      row.registrationReceiptJson,
      "registrationReceiptJson",
    ),
    executionReceipt: parseJsonObject(
      row.executionReceiptJson,
      "executionReceiptJson",
    ),
    testReceipt: parseJsonObject(row.testReceiptJson, "testReceiptJson"),
    runDrainReceipt: parseJsonObject(
      row.runDrainReceiptJson,
      "runDrainReceiptJson",
    ),
    cleanupReceipt: parseJsonObject(
      row.cleanupReceiptJson,
      "cleanupReceiptJson",
    ),
    errorCode: row.errorCode ?? null,
    errorMessage: row.errorMessage ?? null,
    createdBy: row.createdBy ?? null,
    createdAt: timestamp(row.createdAt),
    startedAt: timestamp(row.startedAt),
    finishedAt: timestamp(row.finishedAt),
    updatedAt: timestamp(row.updatedAt),
  });
}

function jsonObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function durableJson(value: Record<string, unknown> | null): string | null {
  return value === null ? null : canonicalEvidenceJson(value);
}

export function sandboxResultIsPromotable(
  result: SandboxDeployResult,
): boolean {
  const execution = result.executionReceipt;
  const cleanup = result.cleanupReceipt;
  const cases = result.caseVerdicts;
  const tester = result.functionTester ?? [];
  const candidateFingerprint = result.candidateFingerprint?.trim() ?? "";
  const targetDomainId = result.targetDomainId?.trim() ?? "";
  const sandboxAttemptId = result.sandboxAttemptId?.trim() ?? "";
  const expectedFunctionIds = tester.map((entry) => entry.short);
  const executionIssues = sandboxExecutionReceiptIssues(execution, {
    candidateFingerprint,
    targetDomainId,
    sandboxAttemptId,
    bundleHash: execution?.bundleHash,
    modelUsageHash: result.modelUsage?.evidenceHash,
  });
  const registrationIssues = sandboxRegistrationEvidenceIssues(
    {
      appId: result.appId,
      committedManifestFunctionIds: result.committedManifestFunctionIds,
      brokerRegistration: result.brokerRegistration,
    },
    expectedFunctionIds,
  );
  const cleanupIssues = sandboxCleanupReceiptIssues(cleanup, {
    candidateFingerprint,
    targetDomainId,
  });
  const modelUsageIssues = sandboxModelUsageEvidenceIssues(result.modelUsage, {
    sandboxAttemptId,
    bundleHash: execution?.bundleHash,
    targetTenantId: execution?.targetTenantId,
    targetTenantSlug: execution?.targetTenantSlug,
  });
  const exactTesterSet =
    tester.length > 0 &&
    tester.length === result.functionsRegistered &&
    new Set(expectedFunctionIds).size === expectedFunctionIds.length;
  return (
    candidateFingerprint.length > 0 &&
    targetDomainId.length > 0 &&
    sandboxAttemptId.length > 0 &&
    result.simulated === false &&
    executionIssues.length === 0 &&
    registrationIssues.length === 0 &&
    cleanupIssues.length === 0 &&
    modelUsageIssues.length === 0 &&
    execution?.executionOrigin === "remote" &&
    (execution.isolationTier === "remote_container" ||
      execution.isolationTier === "remote_vm") &&
    execution.bundleHash.length > 0 &&
    execution.sandboxAttemptId === sandboxAttemptId &&
    execution.candidateFingerprint === candidateFingerprint &&
    execution.targetDomainId === targetDomainId &&
    result.brokerRegistration?.appId === result.appId &&
    result.brokerRegistration?.observedFunctionCount ===
      result.functionsRegistered &&
    result.reachedSuccessTerminal === true &&
    result.fullChainRan === true &&
    cases?.allPass === true &&
    (cases.results?.length ?? 0) > 0 &&
    cases!.results.every((entry) => entry.pass === true) &&
    exactTesterSet &&
    tester.every(
      (entry) =>
        entry.ran === true &&
        entry.pass === true &&
        entry.qualification === "promotable",
    ) &&
    result.toolMode === "evidence_replay" &&
    result.externalLiveCalls === 0 &&
    result.sandboxReplayEvidenceComplete === true &&
    result.cleanupVerified === true &&
    cleanup?.sandboxAttemptId === sandboxAttemptId &&
    cleanup.appId === result.appId &&
    cleanup.sandboxTenantSlug === result.sandboxTenantSlug &&
    execution.targetTenantSlug === result.sandboxTenantSlug
  );
}

export function createOntoCodeSandboxAttempt(
  ctx: OntoCodeStoreContext,
  input: {
    projectId: string;
    sessionId: string;
    harnessJobId: string;
    ordinal: number;
    packageVersionId: string;
    dependencyRoot: string;
    ontologyHash: string;
    testSuiteHash: string;
    environmentProfileVersionId: string | null;
  },
): OntoCodeSandboxAttempt {
  const now = new Date();
  return getDb().transaction((tx) => {
    const session = tx
      .select()
      .from(ontocodeSessions)
      .where(
        tenantScope(
          ctx,
          ontocodeSessions,
        )(eq(ontocodeSessions.id, input.sessionId)),
      )
      .get();
    const job = tx
      .select()
      .from(ontocodeHarnessJobs)
      .where(
        tenantScope(
          ctx,
          ontocodeHarnessJobs,
        )(eq(ontocodeHarnessJobs.id, input.harnessJobId)),
      )
      .get();
    const packageVersion = tx
      .select()
      .from(ontocodePackageVersions)
      .where(
        tenantScope(
          ctx,
          ontocodePackageVersions,
        )(eq(ontocodePackageVersions.id, input.packageVersionId)),
      )
      .get();
    if (!session || !job || !packageVersion) {
      throw new OntoCodeStoreError(
        "ontocode_sandbox_target_not_found",
        "SandboxAttempt requires an existing tenant-scoped Session, Harness Job and Candidate Package",
        404,
      );
    }
    if (
      session.projectId !== input.projectId ||
      session.ontologySnapshotHash !== input.ontologyHash ||
      (session.environmentProfileVersionId ?? null) !==
        input.environmentProfileVersionId ||
      job.sessionId !== input.sessionId ||
      (job.kind !== "test" && job.kind !== "regression") ||
      job.candidatePackageVersionId !== input.packageVersionId ||
      job.candidateDependencyRoot !== input.dependencyRoot ||
      packageVersion.projectId !== input.projectId ||
      packageVersion.sessionId !== input.sessionId ||
      packageVersion.ontologyHash !== input.ontologyHash ||
      packageVersion.dependencyRoot !== input.dependencyRoot
    ) {
      throw new OntoCodeStoreError(
        "ontocode_sandbox_target_mismatch",
        "SandboxAttempt input does not match the exact Candidate target persisted on the Harness Job",
        409,
        {
          sessionId: input.sessionId,
          harnessJobId: input.harnessJobId,
          packageVersionId: input.packageVersionId,
        },
      );
    }
    const existing = tx
      .select()
      .from(ontocodeSandboxAttempts)
      .where(
        tenantScope(
          ctx,
          ontocodeSandboxAttempts,
        )(
          and(
            eq(ontocodeSandboxAttempts.harnessJobId, input.harnessJobId),
            eq(ontocodeSandboxAttempts.ordinal, input.ordinal),
          ),
        ),
      )
      .get();
    if (existing) {
      const attempt = attemptFromRow(existing);
      if (
        attempt.packageVersionId !== input.packageVersionId ||
        attempt.dependencyRoot !== input.dependencyRoot ||
        attempt.testSuiteHash !== input.testSuiteHash
      ) {
        throw new OntoCodeStoreError(
          "ontocode_sandbox_attempt_idempotency_conflict",
          "This Harness attempt ordinal is already bound to another Candidate input",
          409,
        );
      }
      return attempt;
    }
    const id = `ocsa-${randomUUID().replaceAll("-", "").slice(0, 16)}`;
    const row: typeof ontocodeSandboxAttempts.$inferInsert = {
      id,
      tenantId: ctx.tenantId,
      projectId: input.projectId,
      sessionId: input.sessionId,
      harnessJobId: input.harnessJobId,
      ordinal: input.ordinal,
      packageVersionId: input.packageVersionId,
      dependencyRoot: input.dependencyRoot,
      ontologyHash: input.ontologyHash,
      testSuiteHash: input.testSuiteHash,
      environmentProfileVersionId: input.environmentProfileVersionId,
      factorySandboxAttemptId: null,
      candidateFingerprint: input.dependencyRoot,
      bundleHash: null,
      status: "running",
      qualification: "development_only",
      executionOrigin: null,
      isolationTier: null,
      appId: null,
      sandboxTenantSlug: null,
      registrationReceiptJson: null,
      executionReceiptJson: null,
      testReceiptJson: null,
      runDrainReceiptJson: null,
      cleanupReceiptJson: null,
      errorCode: null,
      errorMessage: null,
      createdBy: ctx.actorId,
      createdAt: now,
      startedAt: now,
      finishedAt: null,
      updatedAt: now,
    };
    tx.insert(ontocodeSandboxAttempts).values(row).run();
    return attemptFromRow(
      row as typeof ontocodeSandboxAttempts.$inferSelect,
    );
  });
}

export function completeOntoCodeSandboxAttempt(
  ctx: Pick<OntoCodeStoreContext, "tenantId">,
  attemptId: string,
  result: SandboxDeployResult,
): OntoCodeSandboxAttempt {
  const now = new Date();
  return getDb().transaction((tx) => {
    const current = tx
      .select()
      .from(ontocodeSandboxAttempts)
      .where(
        tenantScope(
          ctx,
          ontocodeSandboxAttempts,
        )(eq(ontocodeSandboxAttempts.id, attemptId)),
      )
      .get();
    if (!current) {
      throw new OntoCodeStoreError(
        "ontocode_sandbox_attempt_not_found",
        "OntoCode SandboxAttempt not found",
        404,
      );
    }
    if (
      result.candidateFingerprint !== current.candidateFingerprint ||
      result.targetDomainId === undefined ||
      !result.sandboxAttemptId
    ) {
      throw new OntoCodeStoreError(
        "ontocode_sandbox_receipt_mismatch",
        "Sandbox receipt does not match the exact Candidate attempt",
        409,
      );
    }
    const execution = jsonObject(result.executionReceipt);
    const cleanup = jsonObject(result.cleanupReceipt);
    const qualification =
      remoteSandboxResultWasAdapterVerified(result)
      && sandboxResultIsPromotable(result)
      ? "promotable"
      : "development_only";
    const update = tx
      .update(ontocodeSandboxAttempts)
      .set({
        factorySandboxAttemptId: result.sandboxAttemptId,
        bundleHash:
          typeof execution?.bundleHash === "string"
            ? execution.bundleHash
            : null,
        status: "succeeded",
        qualification,
        executionOrigin:
          execution?.executionOrigin === "remote" ? "remote" : "local",
        isolationTier:
          typeof execution?.isolationTier === "string"
            ? execution.isolationTier
            : null,
        appId: result.appId,
        sandboxTenantSlug: result.sandboxTenantSlug ?? null,
        registrationReceiptJson: durableJson(
          jsonObject(result.brokerRegistration),
        ),
        executionReceiptJson: durableJson(execution),
        testReceiptJson: durableJson({
          functionsRegistered: result.functionsRegistered,
          committedManifestFunctionIds:
            result.committedManifestFunctionIds ?? [],
          ran: result.ran,
          deployed: result.deployed,
          reachedSuccessTerminal: result.reachedSuccessTerminal,
          fullChainRan: result.fullChainRan,
          fires: result.fires ?? [],
          runs: result.runs,
          agentRuns: result.agentRuns ?? [],
          caseVerdicts: result.caseVerdicts ?? null,
          functionTester: result.functionTester ?? [],
          toolMode: result.toolMode ?? null,
          externalLiveCalls: result.externalLiveCalls ?? null,
          sandboxReplayEvidenceComplete:
            result.sandboxReplayEvidenceComplete ?? false,
          replayReceipts: result.replayReceipts ?? [],
          modelUsage: result.modelUsage ?? null,
        }),
        runDrainReceiptJson: durableJson(jsonObject(cleanup?.runDrain)),
        cleanupReceiptJson: durableJson(cleanup),
        errorCode: null,
        errorMessage: null,
        finishedAt: now,
        updatedAt: now,
      })
      .where(
        tenantScope(
          ctx,
          ontocodeSandboxAttempts,
        )(
          and(
            eq(ontocodeSandboxAttempts.id, attemptId),
            eq(ontocodeSandboxAttempts.status, "running"),
          ),
        ),
      )
      .run();
    if (update.changes !== 1) {
      const attached = tx
        .select()
        .from(ontocodeSandboxAttempts)
        .where(eq(ontocodeSandboxAttempts.id, attemptId))
        .get();
      if (!attached || attached.factorySandboxAttemptId !== result.sandboxAttemptId) {
        throw new OntoCodeStoreError(
          "ontocode_sandbox_attempt_state_conflict",
          "SandboxAttempt changed while its receipt was committed",
          409,
        );
      }
      return attemptFromRow(attached);
    }
    if (qualification === "promotable" && result.caseVerdicts?.allPass === true) {
      tx.update(ontocodePackageVersions)
        .set({
          status: "verified_candidate",
          validationJson: sql`json_set(${ontocodePackageVersions.validationJson}, '$.sandboxEvidenceIncluded', json('true'), '$.sandboxAttemptId', ${result.sandboxAttemptId}, '$.sandboxQualification', 'promotable', '$.releaseEligible', json('false'))`,
          updatedAt: now,
        })
        .where(
          and(
            eq(ontocodePackageVersions.tenantId, current.tenantId),
            eq(ontocodePackageVersions.id, current.packageVersionId),
            eq(ontocodePackageVersions.dependencyRoot, current.dependencyRoot),
            eq(ontocodePackageVersions.status, "candidate_ready"),
          ),
        )
        .run();
    }
    const completed = tx
      .select()
      .from(ontocodeSandboxAttempts)
      .where(eq(ontocodeSandboxAttempts.id, attemptId))
      .get()!;
    return attemptFromRow(completed);
  });
}

export function failOntoCodeSandboxAttempt(
  ctx: Pick<OntoCodeStoreContext, "tenantId">,
  attemptId: string,
  input: {
    status: "failed" | "blocked" | "cleanup_failed";
    code: string;
    message: string;
  },
): OntoCodeSandboxAttempt {
  const now = new Date();
  getDb()
    .update(ontocodeSandboxAttempts)
    .set({
      status: input.status,
      errorCode: input.code.slice(0, 200),
      errorMessage: input.message.slice(0, 8_000),
      finishedAt: now,
      updatedAt: now,
    })
    .where(
      tenantScope(
        ctx,
        ontocodeSandboxAttempts,
      )(
        and(
          eq(ontocodeSandboxAttempts.id, attemptId),
          eq(ontocodeSandboxAttempts.status, "running"),
        ),
      ),
    )
    .run();
  return getOntoCodeSandboxAttempt(ctx, attemptId);
}

export function getOntoCodeSandboxAttempt(
  ctx: Pick<OntoCodeStoreContext, "tenantId">,
  attemptId: string,
): OntoCodeSandboxAttempt {
  const row = getDb()
    .select()
    .from(ontocodeSandboxAttempts)
    .where(
      tenantScope(
        ctx,
        ontocodeSandboxAttempts,
      )(eq(ontocodeSandboxAttempts.id, attemptId)),
    )
    .get();
  if (!row) {
    throw new OntoCodeStoreError(
      "ontocode_sandbox_attempt_not_found",
      "OntoCode SandboxAttempt not found",
      404,
    );
  }
  return attemptFromRow(row);
}

export function listOntoCodeSandboxAttempts(
  ctx: Pick<OntoCodeStoreContext, "tenantId">,
  sessionId: string,
  input: {
    limit: number;
    offset: number;
    status?: OntoCodeSandboxAttempt["status"];
    qualification?: OntoCodeSandboxAttempt["qualification"];
  },
): Page<OntoCodeSandboxAttempt> {
  getOntoCodeSession(ctx, sessionId);
  const filters = [eq(ontocodeSandboxAttempts.sessionId, sessionId)];
  if (input.status) {
    filters.push(eq(ontocodeSandboxAttempts.status, input.status));
  }
  if (input.qualification) {
    filters.push(
      eq(ontocodeSandboxAttempts.qualification, input.qualification),
    );
  }
  const rows = getDb()
    .select()
    .from(ontocodeSandboxAttempts)
    .where(tenantScope(ctx, ontocodeSandboxAttempts)(and(...filters)))
    .orderBy(
      desc(ontocodeSandboxAttempts.createdAt),
      desc(ontocodeSandboxAttempts.id),
    )
    .limit(input.limit + 1)
    .offset(input.offset)
    .all()
    .map(attemptFromRow);
  const hasNext = rows.length > input.limit;
  const items = hasNext ? rows.slice(0, input.limit) : rows;
  return {
    items,
    count: items.length,
    nextOffset: hasNext ? input.offset + input.limit : null,
  };
}
