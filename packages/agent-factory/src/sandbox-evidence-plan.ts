import { createHash } from "node:crypto";
import { stableJson } from "@agentic/shared/cassette";
import type { FactoryExecutionScope, FactoryHumanAuthorizationReceipt } from "./authorization-challenge";
import type { FactorySignedFixtureExchange } from "./ports";

export const SANDBOX_EVIDENCE_PLAN_SCHEMA = "agent-factory-sandbox-evidence-plan/v1" as const;
export const SANDBOX_EVIDENCE_PLAN_AUTHORIZATION_PROTOCOL_VERSION = 1;
export const SANDBOX_EVIDENCE_PLAN_AUTHORIZATION_PREFIX = "authorize_sandbox_evidence_plan:v1:";
export const SANDBOX_EVIDENCE_PLAN_AUTHORIZATION_CONTEXT_PREFIX = "sandbox_evidence_plan_authorization:v1:";
export const SANDBOX_EVIDENCE_PLAN_AUTHORIZATION_DECLINE_PREFIX = "decline_sandbox_evidence_plan:v1:";
export const CONSUMED_SANDBOX_EVIDENCE_PLAN_AUTHORIZATION_PREFIX = "consumed_sandbox_evidence_plan_authorization:v1:";

export interface SandboxEvidencePlanUse {
  actionName: string;
  requiredObjects?: string[];
}

export interface SandboxEvidencePlanBindingRequest {
  toolName: string;
  profileKey?: string;
  config?: Record<string, unknown>;
  uses: SandboxEvidencePlanUse[];
  exchanges: FactorySignedFixtureExchange[];
}

export interface SandboxEvidencePlanRequest {
  domain: string;
  bindings: SandboxEvidencePlanBindingRequest[];
  recordedAt: string;
  expiresAt: string;
  execution: FactoryExecutionScope;
}

export interface SandboxEvidencePlanPreparedBinding {
  toolName: string;
  profileKey?: string;
  definitionHash: string;
  schemaHash: string;
  configHash: string;
  uses: SandboxEvidencePlanUse[];
  fixtureSubjectDigest: string;
  review: string[];
}

export interface SandboxEvidencePlanPreparation {
  schema: typeof SANDBOX_EVIDENCE_PLAN_SCHEMA;
  subjectDigest: string;
  domain: string;
  runId: string;
  conversationId: string;
  recordedAt: string;
  expiresAt: string;
  bindings: SandboxEvidencePlanPreparedBinding[];
  review: string[];
  sandboxOnly: true;
  promotionAllowed: false;
}

export interface SandboxEvidencePlanCommittedProfile {
  profileKey: string;
  toolName: string;
  configHash: string;
  environment: "sandbox";
}

export interface SandboxEvidencePlanCommittedFixture {
  toolName: string;
  definitionHash: string;
  configHash: string;
  cassettePath: string;
  attestationKeyId: string;
  attestationExpiresAt: string;
}

export interface SandboxEvidencePlanReceipt extends SandboxEvidencePlanPreparation {
  status: "ready";
  confirmedBy: string;
  profiles: SandboxEvidencePlanCommittedProfile[];
  fixtures: SandboxEvidencePlanCommittedFixture[];
}

export interface SandboxEvidencePlanStore {
  prepare(request: SandboxEvidencePlanRequest): Promise<SandboxEvidencePlanPreparation>;
  commit(
    request: SandboxEvidencePlanRequest & {
      expectedSubjectDigest: string;
      authorization: FactoryHumanAuthorizationReceipt;
    },
  ): Promise<SandboxEvidencePlanReceipt>;
}

export function sandboxEvidencePlanSubject(input: {
  tenantId: string;
  tenantSlug: string;
  preparation: Omit<SandboxEvidencePlanPreparation, "subjectDigest" | "review">;
}): string {
  return createHash("sha256").update(stableJson({
    tenantId: input.tenantId,
    tenantSlug: input.tenantSlug,
    ...input.preparation,
  })).digest("hex");
}

export function sandboxEvidencePlanChallengeToken(subjectDigest: string): string {
  return `${SANDBOX_EVIDENCE_PLAN_AUTHORIZATION_PREFIX}${subjectDigest}`;
}
