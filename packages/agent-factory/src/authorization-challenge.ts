/** Durable one-shot authorization protocol shared by profile confirmation and
 * side-effecting live probes. Challenge tokens are opaque digests; the
 * authenticated responder identity is attached only when the answer is
 * consumed, never borrowed from the actor who started the run. */

/** Probe challenge protocol. Integration-profile challenges use the profile
 * protocol version because their subject includes the environment boundary. */
export const FACTORY_AUTHORIZATION_PROTOCOL_VERSION = 2;

export type FactoryAuthorizationChallengeKind =
  | "integration_profile"
  | "probe"
  | "sandbox_evidence_plan"
  | "sandbox_design_review";

/** Current Factory execution identity. The API deliberately uses one durable
 * id as both the run primary key and conversation checkpoint key today. We
 * keep both named fields so every receipt verifies the caller's current
 * execution coordinates, without pretending they are independent scopes. */
export interface FactoryExecutionScope {
  runId: string;
  conversationId: string;
}

export function factoryExecutionScope(executionId: string): FactoryExecutionScope {
  const id = executionId.trim();
  if (!id) throw new Error("factory execution id is required");
  return { runId: id, conversationId: id };
}

/** Authenticated mailbox envelope. `actor` is absent only for legacy/non-auth
 * messages; such a message may steer the run but can never authorize I/O. */
export interface FactoryHumanMessage {
  text: string;
  actor?: string;
  receivedAt?: number;
  /** Stable id of the durable mailbox batch. Absent only for legacy/custom ports. */
  deliveryId?: string;
  /** Exact one-shot HITL interaction this answer was submitted for. A durable
   * API/mailbox delivery must carry both fields whenever a human gate is open;
   * legacy/custom in-memory ports may omit them for backwards compatibility. */
  interactionId?: string;
  gateKind?: FactoryHumanInteractionKind;
}

export type FactoryHumanInteractionKind =
  | "clarify"
  | "test_approval"
  | "boundary";

/** Persisted with the conversation checkpoint. The opaque id is a one-shot
 * coordination token, not an authorization capability. */
export interface FactoryPendingHumanInteraction {
  interactionId: string;
  kind: FactoryHumanInteractionKind;
  subjectDigest: string;
  createdAt: number;
}

export interface FactoryAuthorizationChallengeOption {
  label: string;
  value: string;
  recommended: boolean;
}

export interface FactoryAuthorizationChallenge {
  id: string;
  kind: FactoryAuthorizationChallengeKind;
  protocolVersion: number;
  digest: string;
  subjectDigest: string;
  token: string;
  question: string;
  context: string;
  options: FactoryAuthorizationChallengeOption[];
  runId: string;
  conversationId: string;
  /** Server deadline. A challenge cannot be consumed or verified at/after it. */
  expiresAt: string;
}

/** Receipt returned only after a tenant/domain/run/conversation-exact DB row
 * has been atomically consumed by an authenticated responder. */
export interface FactoryHumanAuthorizationReceipt {
  challengeId: string;
  kind: FactoryAuthorizationChallengeKind;
  protocolVersion: number;
  digest: string;
  subjectDigest: string;
  authorizationDigest: string;
  actor: string;
  runId: string;
  conversationId: string;
  consumedAt: string;
  expiresAt: string;
}

export interface FactoryAuthorizationChallengeStore {
  issue(
    domain: string,
    input: {
      kind: FactoryAuthorizationChallengeKind;
      subjectDigest: string;
      runId: string;
      conversationId: string;
      question: string;
      declineLabel: string;
      confirmLabel: string;
    },
  ): Promise<FactoryAuthorizationChallenge>;

  /** Rehydrate a redacted conversation checkpoint from the authoritative DB
   * row. Returns null for missing, consumed, expired, or scope-mismatched refs. */
  restore(
    domain: string,
    input: Pick<FactoryAuthorizationChallenge, "id" | "kind" | "protocolVersion" | "digest" | "subjectDigest" | "runId" | "conversationId" | "expiresAt">,
  ): Promise<FactoryAuthorizationChallenge | null>;

  consume(
    domain: string,
    input: {
      challenge: FactoryAuthorizationChallenge;
      answer: string;
      actor: string;
      question: string;
      context: string;
      options: FactoryAuthorizationChallengeOption[];
    },
  ): Promise<FactoryHumanAuthorizationReceipt>;
}
