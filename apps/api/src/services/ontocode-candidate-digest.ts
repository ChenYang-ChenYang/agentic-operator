import { createHash } from "node:crypto";
import type {
  OntoCodeCandidateTestCase,
  OntoCodeExecutionOwner,
  OntoCodePackageVersion,
} from "@agentic/contracts";
import { canonicalEvidenceJson } from "@agentic/shared";

type CandidateArtifactRef = OntoCodePackageVersion["artifactRefs"][number];

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function computeOntoCodeCandidateDependencyRoot(input: {
  ontologyHash: string;
  environmentProfileVersionId: string | null;
  artifactRefs: readonly CandidateArtifactRef[];
  executionOwners: Record<string, OntoCodeExecutionOwner>;
}): string {
  const artifactRefs = [...input.artifactRefs]
    .map((artifact) => ({
      logicalName: artifact.logicalName,
      kind: artifact.kind,
      artifactVersionId: artifact.artifactVersionId,
      blobHash: artifact.blobHash,
    }))
    .sort(
      (left, right) =>
        left.logicalName.localeCompare(right.logicalName) ||
        left.artifactVersionId.localeCompare(right.artifactVersionId),
    );
  return sha256(
    canonicalEvidenceJson({
      ontologyHash: input.ontologyHash,
      environmentProfileVersionId: input.environmentProfileVersionId,
      artifacts: artifactRefs,
      executionOwners: input.executionOwners,
    }),
  );
}

export function computeOntoCodeTestSuiteHash(
  testCases: readonly OntoCodeCandidateTestCase[],
): string {
  return sha256(
    canonicalEvidenceJson(
      [...testCases].sort(
        (left, right) =>
          left.id.localeCompare(right.id) ||
          left.entryEvent.localeCompare(right.entryEvent),
      ),
    ),
  );
}

export function computeOntoCodeCandidateJobInputHash(input: {
  kind: string;
  commandId: string | null;
  candidatePackageVersionId: string;
  candidateDependencyRoot: string;
  candidateHeadId: string;
  candidateHeadRevision: number;
  testCases: readonly OntoCodeCandidateTestCase[];
}): string {
  return sha256(
    canonicalEvidenceJson({
      ...input,
      testCases: [...input.testCases],
    }),
  );
}

