// The injected PORTS that decouple the brain from the OLD repo's concrete
// infrastructure (Prisma/Postgres, Inngest dynamic createFunction, Neo4j/Allmeta).
//
// This is the keystone of the migration. The conductor + tools will depend ONLY on
// these interfaces; each runtime provides a concrete implementation:
//   - the OLD app  → Neo4j/Allmeta + dynamic createFunction + Postgres tables
//   - the NEW apps/api → manifest JSON (models/<tenant>/) + manifest-import + Drizzle
//
// Defining the ports up-front (M1-b) is what lets M1-c port the conductor without
// dragging Prisma/Inngest/Neo4j along, and lets M2/M3 implement deploy + storage for
// the new architecture behind a stable surface. Signatures are the migration's
// design contract; concrete method shapes get finalized as the conductor is ported.

import type { DomainOntology } from "./ontology-types";
import type { GeneratedAgentSpec } from "./spec-types";
import type { AgentRunIO, BoundaryEvent, TestCase } from "./brain-types";
import type { RealTool } from "./tool-catalog";
import type { IntegrationCapabilityProvider } from "./integration-binding";
import type { IntegrationProfile } from "./integration-profile";
import type {
  FactoryAuthorizationChallengeStore,
  FactoryHumanMessage,
  FactoryHumanAuthorizationReceipt,
} from "./authorization-challenge";

/** Reads the business ontology the factory grounds agents in.
 *  OLD: Neo4j/Allmeta (lib/ontology-generator/ontology-source).
 *  NEW: manifest JSON under models/<tenant>/ (the new monorepo dropped Neo4j). */
export interface OntologySource {
  /** front-desk intent: enumerate available domains (the list_domains tool). */
  listDomains(): Promise<Array<{ id: string; name?: string; counts?: Record<string, number> }>>;
  /** Strict, no-fallback live read — the factory refuses to hallucinate against a
   *  stub, so a missing domain throws rather than returning an empty ontology. */
  fetchOntology(domainId: string): Promise<DomainOntology>;
  /** Action→step→Rule edges fetched live, so rule-check BINDS rules at run time
   *  instead of baking them into a prompt (the fetchActionRules tool). */
  fetchActionRules(domainId: string, actionName: string): Promise<unknown[]>;
}

/** #TESTER-WIRE — one spec's P2.5 function-tester verdict: its rendered .ts deliverable was
 *  REALLY EXECUTED in isolation (worker/process/container) against a test event. Structural
 *  gate: module loads, control flow runs, a DECLARED event was emitted. Semantic verdicts stay
 *  the sandbox chain's job. */
export interface FunctionTesterEntry {
  short: string;
  pass: boolean;
  ran: boolean;
  emitNames: string[];
  reasons: string[];
  /** isolation tier actually used (worker/process/container). */
  tier: string;
  /** Only an externally isolated container/VM can authorize promotion. Local
   * worker/process/container runs remain useful developer diagnostics. */
  qualification?: "development_only" | "promotable";
  /** `evidence` means definition-bound probe/record cassettes were available;
   * `scripted` is limited to no-external-tool decision/invoke seams. */
  fixtureMode?: "evidence" | "scripted" | "missing";
}

export const SANDBOX_RUN_DRAIN_RECEIPT_SCHEMA = "agent-factory-sandbox-run-drain/v1" as const;

export interface SandboxRunDrainReceipt {
  schema: typeof SANDBOX_RUN_DRAIN_RECEIPT_SCHEMA;
  sandboxAttemptId: string;
  appId: string;
  sandboxTenantSlug: string;
  startedAt: string;
  completedAt: string;
  observedRuns: Array<{
    runId: string;
    initialStatus: string;
    finalStatus: "ok" | "failed" | "cancelled";
    /** SHA-256 only; raw business subjects never enter promotion evidence. */
    subjectHash: string;
    cancelEventId?: string;
    cancelAcceptedAt?: string;
  }>;
  evidenceHash: string;
}

export const SANDBOX_CLEANUP_RECEIPT_SCHEMA = "agent-factory-sandbox-cleanup/v2" as const;

/** Secret-free proof that the exact ephemeral app used for one candidate was
 * deleted and then read back as absent. This is factory evidence, not a live
 * deployment pointer: production promotion may bind its hash but must never
 * deploy, register or reuse this app identity. */
export interface SandboxCleanupReceipt {
  schema: typeof SANDBOX_CLEANUP_RECEIPT_SCHEMA;
  appId: string;
  sandboxTenantSlug: string;
  sandboxAttemptId: string;
  candidateFingerprint: string;
  targetDomainId: string;
  /** Proof that dispatch was closed first and every attempt-owned DB run was
   * terminal before app deletion. App absence is not a substitute. */
  runDrain: SandboxRunDrainReceipt;
  deletedAt: string;
  absence: {
    connected: false;
    functionCount: null;
    registryState: "not_registered";
  };
  /** Canonical hash of every field above. The broker credential and delete
   * endpoint are intentionally excluded and never leave the runtime adapter. */
  absenceProbeHash: string;
}

/** Secret-free receipt authored at the deployed nonce app's actual tool
 * boundary. It contains hashes only—never arguments, responses or secrets. */
export interface SandboxToolDispatchReceipt {
  schema: "agent-factory-sandbox-dispatch/v1";
  attemptId: string;
  tenantSlug: string;
  tool: string;
  kind: "replay" | "replay_miss" | "sandbox_local" | "external_live";
  effectScope: "none" | "sandbox_local" | "external";
  argsHash: string;
  cassetteKey: string;
  definitionHash?: string;
  contentHash?: string;
  responseStatus?: number;
  at: string;
}

export const SANDBOX_BROKER_REGISTRATION_SCHEMA =
  "agent-factory-sandbox-broker-registration/v1" as const;

/** Independent control-plane observation of the ephemeral Inngest App. The
 * committed manifest below says what the Factory asked to deploy; this receipt
 * says what the broker subsequently observed. Keeping the two separate avoids
 * turning a locally synthesized spec list into registration evidence. */
export interface SandboxBrokerRegistrationProof {
  schema: typeof SANDBOX_BROKER_REGISTRATION_SCHEMA;
  appId: string;
  expectedFunctionCount: number;
  observedFunctionCount: number | null;
  connected: boolean;
  verified: boolean;
  evidence: "dev_graphql" | "cloud_sync_acceptance" | "test_only_bypass";
  checkedAt: string;
  error?: string;
}

/** What a sandbox deploy + observe returns — the deploy evidence the finish gate
 *  checks (functionsRegistered>0, ran===deployed, reachedSuccessTerminal). */
export interface SandboxDeployResult {
  appId: string;
  /** Count returned by the local manifest commit. This is useful diagnostics,
   * but is not independent broker evidence and cannot by itself pass
   * `real_register`. */
  functionsRegistered: number;
  ran: number;
  deployed: number;
  reachedSuccessTerminal: boolean;
  fullChainRan: boolean;
  /** #REDESIGN P1 — spec shorts whose GENERATED CODE actually EXECUTED (runs.code_ran=true), not
   *  fell back to declarative. finish requires every codeExecuted spec to be here. */
  codeRanAgents?: string[];
  degradedAgents: string[];
  runs: Array<{ id: string; status: string }>;
  /** per-agent REAL I/O reconstructed after the run settled (Feature: agent-io). */
  agentRuns?: AgentRunIO[];
  /** content hash of the deployed specs — guards against a stale prior sandbox. */
  fingerprint: string;
  /** Legacy evidence marker retained for stored transcripts. New runtime
   * verification always writes false because only real Inngest deploys run. */
  simulated?: boolean;
  /** R2: per-fired-event delivery trace — was silently swallowed (.catch(()=>{})). Lets the
   *  brain/UI see which `${tenant}/${event}` envelopes Inngest actually accepted. */
  fires?: Array<{ event: string; ok: boolean; error?: string }>;
  /** Exact function IDs contained in the immutable manifest submitted by this
   * attempt. These are commit intent, not an observation from Inngest. */
  committedManifestFunctionIds?: string[];
  /** Exact-count readback from the Inngest control plane after sync. */
  brokerRegistration?: SandboxBrokerRegistrationProof;
  /** @deprecated Legacy transcripts mislabeled locally synthesized manifest
   * IDs as registered IDs. New runs write `committedManifestFunctionIds` and
   * `brokerRegistration`; this field is never accepted as production proof. */
  registeredIds?: string[];
  /** #AUDIT-FIX(H2) — 沙箱 app 是否真的在 Inngest dev server 完成注册/发现。false + ran:0 =
   *  【环境问题】（serve URL 配错/回连失败），不是 agent 设计问题——避免大脑按错误归因
   *  反复 refine 死循环。 */
  appReady?: boolean;
  /** #AUDIT-FIX(H2) — app 注册（PUT serve URL）失败时的底层错误文本。 */
  syncError?: string;
  /** External-platform trigger events with no approved test case/payload. Production sandboxes stop
   * before dispatch when this is non-empty; these inputs must never be fabricated as `{}`. */
  uncoveredExternalInputs?: string[];
  /** #D — 跑通 redefinition: how the chain closed. internalChains = agents that ran into an
   *  internal/success terminal; externalTerminals = agents whose emit is a legitimate external
   *  HANDOFF (consumed by an external platform, not a broken chain). Surfaced so the UI shows
   *  "整链跑通：N 内部链 + M 外部交接终态". */
  internalChains?: number;
  externalTerminals?: number;
  /** T1 — per-test-case verdict by KIND (pass→reached success terminal; reject→reached FAIL
   *  terminal, NOT counted against success; edge→completed without crash). Present when the fired
   *  cases carried a kind; its allPass then drives fullChainRan (resolving the reject-case
   *  contradiction where a correct rejection used to fail a success-only chain gate). */
  caseVerdicts?: {
    allPass: boolean;
    results: Array<{ caseId?: string; kind: string; pass: boolean; reason: string }>;
    byKind: Record<string, { total: number; passed: number }>;
  };
  /** T2 — mock external-platform agents auto-synthesized to close external handoffs in the sandbox
   *  (slugs contain "-mock-"; excluded from the real-deliverable count). */
  mockExternalAgents?: string[];
  /** #TESTER-WIRE — per-spec P2.5 function-tester verdicts (rendered .ts deliverable really executed
   *  in isolation). Undefined on simulated runs / legacy deployers; acceptance treats a REAL run
   *  without this evidence as UNKNOWN (blocks finish) — same 3-state semantics as execution_fidelity. */
  functionTester?: FunctionTesterEntry[];
  /** #TESTER-WIRE — the sandbox chain's tool dispatch mode (mock/replay/live/gated). Surfaced in the
   *  acceptance detail so a mock-tooled pass can't masquerade as production-verified. */
  toolMode?: string;
  /** Attempt-bound replay evidence from the full Inngest run (not merely the
   * pre-deploy function tester). Null means the ledger could not be read and
   * therefore must not be interpreted as zero. */
  externalLiveCalls?: number | null;
  replayReceipts?: SandboxToolDispatchReceipt[];
  sandboxDispatches?: SandboxToolDispatchReceipt[];
  sandboxReplayEvidenceComplete?: boolean;
  /** Control-plane references to the exact cassette files whose canonical
   * documents were sealed into the submitted remote bundle. These paths never
   * cross into the workload and are attached only after the runner receipt is
   * verified. Draft persistence re-reads and content-addresses them, so a
   * probe file changed during/after the run fails closed. */
  cassetteRefs?: Array<{
    bindingId?: string;
    specSlugs?: string[];
    tool: string;
    path: string;
    definitionHash: string;
    schemaHash?: string;
    contentHash: string;
    /** API-verified evidence identity copied from the signed cassette.  This
     * prevents a simulation fixture from being summarized as a production
     * live probe during finish/promotion. */
    evidenceMode?: "live-probe" | "signed-fixture" | "runtime-record";
    configHash?: string;
    attestationKeyId?: string;
    attestationExpiresAt?: string;
    writeProbe?: {
      schema: "agent-factory-write-probe/v1";
      createCompleted: boolean;
      cleanupCompleted: boolean;
      absenceVerified: boolean;
      idempotencyKeyHash: string;
    };
  }>;
  /** Canonical immutable candidate identity supplied by the factory and stamped
   * into the ephemeral manifest. Promotion evidence must refer to this exact
   * value; an Inngest app/deployment id is never promotable evidence. */
  candidateFingerprint?: string;
  /** Exact Ontology/delivery domain the candidate is intended to serve. */
  targetDomainId?: string;
  /** Unique test attempt identity. Every code revision receives a fresh one. */
  sandboxAttemptId?: string;
  /** Non-secret ephemeral tenant namespace used for app/event isolation. */
  sandboxTenantSlug?: string;
  /** True only after the broker proved the ephemeral app identity absent (a
   * surviving zero-function app is insufficient), local handler/client state
   * was evicted and the sandbox model source was removed. */
  cleanupVerified?: boolean;
  /** Present only after verified teardown completes. */
  cleanupReceipt?: SandboxCleanupReceipt;
  /** Signed proof that generated code executed outside the Factory API
   * control plane. New promotion evidence requires this receipt. */
  executionReceipt?: import("./sandbox-execution-plane").SandboxExecutionPlaneReceipt;
  /** Real semantic-model usage, distinct from external tool dispatch. A value
   * of externalLiveCalls=0 says nothing about this ledger. */
  modelUsage?: import("./sandbox-model-usage").SandboxModelUsageEvidence;
}

export interface SandboxLifecycleBlock {
  code:
    | "target_scope_missing"
    | "sandbox_config_missing"
    | "sandbox_fixture_invalid"
    | "sandbox_isolation_invalid"
    | "sandbox_execution_failed"
    | "sandbox_unregister_unavailable"
    | "sandbox_cleanup_failed";
  next: "ask_user";
  question: string;
  missing: string[];
}

/** Typed, model-safe lifecycle stop. It carries no credentials or raw URLs. */
export class SandboxLifecycleBlockedError extends Error {
  readonly block: SandboxLifecycleBlock;

  constructor(block: SandboxLifecycleBlock) {
    super(block.question);
    this.name = "SandboxLifecycleBlockedError";
    this.block = block;
  }
}

/** Deploys generated specs to a sandbox, fires an entry event, observes the run,
 *  then tears down.
 *  OLD: dynamic createFunction + registerDomainApp (server/inngest/domain-app).
 *  NEW: write models/<tenant>/workflow.json → manifest-import commit → reregister. */
export interface SandboxDeployer {
  deployAndObserve(
    domainId: string,
    specs: GeneratedAgentSpec[],
    opts?: {
      dryRun?: boolean;
      // T1: a test case may carry its KIND so the deployer fires it on a distinct subject and
      // judges its outcome per-kind (reject reaching a FAIL terminal = pass).
      testCases?: Array<Pick<TestCase, "entryEvent" | "payload" | "kind" | "expectedEvent"> & { id?: string }>;
      /** #D — the user's boundary classification, threaded to the verdict so an external-handoff
       *  emit (consumed by an external platform) counts as a legitimate terminal, not a broken chain. */
      boundaryEvents?: Array<{ event: string; kind: string }>;
      /** Canonical evidence identity computed before any deploy side effect. */
      candidateFingerprint?: string;
      /** Exact Factory conversation that owns any content-addressed test
       * fixture bindings. Raw bytes are resolved only inside the server-side
       * sandbox adapter and never enter the brain transcript. */
      fixtureConversationId?: string;
      /** User/run cancellation. Implementations must unwind through cleanup. */
      signal?: AbortSignal;
    },
  ): Promise<SandboxDeployResult>;
  /** Emergency/idempotent cleanup of any in-flight attempts. Normal attempts
   * clean themselves in deployAndObserve's finally block. */
  teardown(domainId: string): Promise<void>;
}

/** Durable brain conversation + the human-message mailbox (HITL inject).
 *  OLD: Postgres factory_conversation + factory_human_msg.
 *  NEW: Drizzle/SQLite. Rehydrate-before-resume is what survives a server restart. */
export interface ConversationStore {
  has(conversationId: string): Promise<boolean>;
  load(conversationId: string): Promise<{ messages: unknown[]; ctx: Record<string, unknown> } | null>;
  save(
    conversationId: string,
    snapshot: { domain: string; messages: unknown[]; ctx: Record<string, unknown> },
  ): Promise<void>;
  /** Lease queued human messages to inject at the next turn boundary (HITL).
   *  Durable implementations redeliver the same deliveryId until acked. */
  drainHumanMessages(conversationId: string): Promise<FactoryHumanMessage[]>;
  /** Acknowledge only after a conversation checkpoint durably contains the batch's effects. */
  ackHumanMessages?(conversationId: string, deliveryId: string): Promise<void>;
  /** Return an uncheckpointed batch for immediate redelivery. */
  nackHumanMessages?(conversationId: string, deliveryId: string): Promise<void>;
}

/** Persists + loads failure reflections (what failed + the lesson) so later runs
 *  learn. OLD: FailureReflection table. NEW: Drizzle/SQLite.
 *  Implementations fail closed: callers must surface persistence failures rather
 *  than continue with an untracked success/failure verdict. */
export interface ReflectionWriter {
  record(
    domainId: string,
    // Phase 5 — `kind` carries the real failure/success/caveat distinction so it round-trips into
    // the next build's lessons (was dropped: stores hardcoded "caveat", flattening the signal).
    reflection: { summary: string; lesson: string; failedStep?: string; kind?: "failure" | "success" | "caveat" },
  ): Promise<void>;
  /** prior reflections for this domain, newest first — injected into the system prompt. */
  list(
    domainId: string,
  ): Promise<Array<{ kind: "failure" | "success" | "caveat"; summary: string; rootCause?: string; lesson: string; createdAt: string }>>;
}

/** A reusable SKILL the brain authored — woven into agent prompts + persisted across
 *  runs (the OLD skills-library/<slug>/SKILL.md, now Drizzle-backed). */
export interface LibrarySkill {
  slug: string;
  name: string;
  purpose: string;
  promptFragment: string;
  tools: string[];
  decisionRule: string;
  domain: string | null; // null = cross-domain (general)
  useCount: number;
  evalCount: number;
  successCount: number;
  // #P5 — 可实例化技能(向后兼容:老技能无这两个字段,仍照常织入 promptFragment)。
  /** 若存在,则该技能可经 instantiate_subagent 生成一个 L2 sub-agent(不只织入提示词)。 */
  spawnSpec?: import("./capability-ladder").SpawnSpec;
  /** 生命周期:缺省视为 active(老技能);锻造品落 draft,首用成功才 active。 */
  lifecycle?: import("./capability-ladder").SkillLifecycle;
}

/** Persistent skills library — create/use/persist + effectiveness scoring. */
export interface SkillStore {
  /** skills usable for a domain (domain-specific + general), ranked by effectiveness then use. */
  list(domain: string): Promise<LibrarySkill[]>;
  save(skill: Omit<LibrarySkill, "useCount" | "evalCount" | "successCount">): Promise<void>;
  bumpUse(slug: string): Promise<void>;
  /** record whether a run that USED this skill ended green (effectiveness signal). */
  recordEval(slug: string, ok: boolean): Promise<void>;
}

/** Optional web search for the brain's research (web_search tool). */
export interface WebSearch {
  search(query: string): Promise<Array<{ title: string; url: string; snippet: string }>>;
}

export interface DeclarativeMultipartFileSpec {
  /** Multipart field name fixed by the vendor contract. */
  field: string;
  /** Dotted path into args/config/lastResult scope containing canonical base64. */
  base64Path: string;
  filename?: string;
  filenamePath?: string;
  mime?: string;
  mimePath?: string;
  required?: boolean;
}

export interface DeclarativeRequestSpec {
  encoding: "json" | "multipart";
  /** JSON mode: dotted source path; omitted means the explicit tool args. */
  bodyPath?: string;
  /** Multipart text field → value template (`{dotted.path}`). */
  fields?: Record<string, string>;
  files?: DeclarativeMultipartFileSpec[];
  maxBytes?: number;
}

export interface DeclarativeResponseAssertion {
  path: string;
  op: "exists" | "non_empty" | "eq" | "neq" | "in" | "not_in";
  value?: unknown;
  values?: unknown[];
  /** Retry semantics are explicit evidence, not inferred from prose. */
  failure: "retryable" | "terminal";
  code: string;
  message?: string;
}

export interface DeclarativeResponseSpec {
  /** Return this subtree when no mappings are supplied. */
  unwrapPath?: string;
  /** Normalized output field → dotted path in the raw response envelope. */
  mappings?: Record<string, string>;
  assertions?: DeclarativeResponseAssertion[];
}

export interface DeclarativeExchangeExample {
  request: Record<string, unknown>;
  response: unknown;
  note?: string;
  source?: "human" | "probe" | "documentation";
}

/** Sanitized observation produced by a guarded live probe. Headers and secret
 * material are intentionally absent; implementations also bound body sizes. */
export interface DeclarativeProbeObservedEvidence {
  stage: string;
  request?: { method: string; url: string; body: unknown };
  response?: { status: number; body: unknown };
  failure?: { kind: string; code: string; retryable: boolean };
}

/** A human-reviewed sandbox fixture is authored from ordinary tool arguments
 * and a redacted expected response.  The concrete API turns these exchanges
 * into canonical cassette entries so the model never gets to invent request
 * hashes or claim a definition identity. */
export interface FactorySignedFixtureExchange {
  args: Record<string, unknown>;
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

export interface FactorySignedFixtureRequest {
  domain: string;
  name: string;
  config?: Record<string, unknown>;
  exchanges: FactorySignedFixtureExchange[];
  recordedAt: string;
  expiresAt: string;
}

export interface FactorySignedFixturePreparation {
  subjectDigest: string;
  definitionHash: string;
  schemaHash: string;
  configHash: string;
  recordedAt: string;
  expiresAt: string;
  /** Short, secret-free lines rendered inside the server-owned confirmation
   * question. Exact bytes are additionally covered by subjectDigest. */
  review: string[];
}

export interface FactorySignedFixtureReceipt extends FactorySignedFixturePreparation {
  verified: true;
  evidenceMode: "signed-fixture";
  cassettePath: string;
  attestationKeyId: string;
  attestationExpiresAt: string;
  confirmedBy: string;
}

/** A declarative, AI-authored HTTP tool (Tool-Smith). NEVER eval'd — it's a spec the
 *  runtime executes via a guarded fetch (egress-guard). Persisted so a future run /
 *  a deployed agent can bind it by name. */
export interface DeclarativeTool {
  name: string;
  description: string;
  method: string; // GET | POST | ...
  urlTemplate: string; // may contain {placeholders} filled from the event payload
  headers?: Record<string, string>;
  bodyTemplate?: string;
  /** Machine-executable request encoding and response normalization/assertion
   * rules learned from docs, examples or a human-authorized live probe. */
  requestSpec?: DeclarativeRequestSpec;
  responseSpec?: DeclarativeResponseSpec;
  examples?: DeclarativeExchangeExample[];
  sideEffect: string; // "read" | "write" | "dual" — gating hint
  /** New reviewed execution semantics. Historical persisted tools may not
   * have these yet; Agent Factory must ask for an explicit migration instead
   * of deriving them from method/name/sideEffect. */
  operation: import("./spec-types").GeneratedToolExecutionPolicy["operation"];
  effectScope: import("./spec-types").GeneratedToolExecutionPolicy["effectScope"];
  sandboxPolicy: import("./spec-types").GeneratedToolExecutionPolicy["sandboxPolicy"];
  domain: string | null;
  /** R6 — typed I/O contracts (regression vs the OLD PersistedToolSpec): the args the tool
   *  takes + the shape it returns, as JSON-schema-ish field maps. Let the step-engine validate
   *  output and let generated agents agree on shapes (e.g. parseResumeApi is multipart `file`-only,
   *  match wraps under data.data.*). For an EXTERNAL-platform handoff this is the egress contract. */
  paramsSchema?: Record<string, unknown>;
  returnsSchema?: Record<string, unknown>;
  /** Exact integration coverage claimed by this adapter. */
  capabilities?: import("./tool-catalog").ToolCapabilityDescriptor[];
  /** Complete disposable-canary lifecycle. Declarative writes remain
   * needs_config until this is authored and trusted cleanup wiring exists. */
  probeSafety?: import("@agentic/shared").WriteProbeSafetyContract;
  /** A saved/edited tool is unverified until a live probe or signed fixture
   * tied to its current definition hash succeeds. */
  probeStatus?: "required" | "verified" | "failed";
  /** Every definition+config hash backed by a current verified receipt in the
   * tenant/domain receipt store. The single factory_tools evidence columns are
   * only a backwards-compatible display projection and are not authoritative. */
  verifiedDefinitionHashes?: string[];
  /** Subset of verifiedDefinitionHashes backed by an unexpired API-attested
   * live probe. Signed fixtures and runtime recordings never enter this set. */
  productionVerifiedDefinitionHashes?: string[];
  /** Evidence mode of the representative receipt used for catalog display.
   * Exact sandbox/promotion decisions must select a receipt by hash instead. */
  probeEvidenceMode?: "live-probe" | "signed-fixture" | "runtime-record";
  definitionHash?: string;
  probeEvidence?: Record<string, unknown>;
  verifiedAt?: string;
}

/** Persistent tool library (Tool-Smith create_tool) — declarative HTTP tools the brain
 *  authors so a domain that lacks a needed tool can grow one. */
export interface ToolStore {
  list(domain: string): Promise<DeclarativeTool[]>;
  save(tool: DeclarativeTool): Promise<void>;
  /** Optional live probe surface. Implementations must enforce guarded I/O,
   * redact evidence, and persist a definition/config-bound receipt. */
  probe?(request: {
    domain: string;
    name: string;
    args: Record<string, unknown>;
    config?: Record<string, unknown>;
    /** System attribution for read-only probes. Side-effecting probes ignore
     * this and require the actor from `authorization`. */
    actor?: string;
    /** Opaque receipt from a durable one-shot challenge consumption. */
    authorization?: FactoryHumanAuthorizationReceipt;
    /** Current caller execution identity, supplied independently from the
     * receipt and compared again at the final I/O boundary. */
    execution?: import("./authorization-challenge").FactoryExecutionScope;
    /** For a side-effecting call, the hash covered by the one-shot human
     * authorization. Concrete ports must compare it before execution. */
    expectedDefinitionHash?: string;
  }): Promise<{
    verified: boolean;
    classification: string;
    definitionHash: string;
    schemaHash: string;
    status?: number;
    durationMs: number;
    error?: string;
    cassettePath?: string;
    observedEvidence?: DeclarativeProbeObservedEvidence;
    next?: "ask_user";
    missing?: string[];
    writeProbeProof?: import("@agentic/shared/cassette").WriteProbeCassetteProof;
  }>;
  /** Prepare the exact subject for a sandbox-only signed fixture. This is
   * read-only: it resolves the current tenant/global/declarative tool and
   * returns a digest for the durable human challenge. */
  prepareSignedFixture?(
    request: FactorySignedFixtureRequest,
  ): Promise<FactorySignedFixturePreparation>;
  /** Persist a signed fixture only after a one-shot server challenge was
   * consumed by an authenticated human. The implementation must re-resolve
   * the current definition/config and fail closed on drift. */
  createSignedFixture?(
    request: FactorySignedFixtureRequest & {
      expectedDefinitionHash: string;
      expectedSubjectDigest: string;
      authorization: FactoryHumanAuthorizationReceipt;
      execution: import("./authorization-challenge").FactoryExecutionScope;
    },
  ): Promise<FactorySignedFixtureReceipt>;
}

/** Human-confirmed, tenant/domain-scoped integration configuration. The
 * concrete port owns authenticated actor attribution; the model can never
 * supply or override `confirmedBy`. */
export interface IntegrationProfileStore {
  save(
    domain: string,
    input: {
      profileKey: string;
      environment: import("./integration-profile").IntegrationProfileEnvironment;
      tool: RealTool;
      config: Record<string, unknown>;
      authorization: FactoryHumanAuthorizationReceipt;
      /** Current caller execution identity, not copied from the receipt. */
      execution: import("./authorization-challenge").FactoryExecutionScope;
    },
  ): Promise<IntegrationProfile>;
}

/** A persisted, generated agent — the durable DRAFT a finished run produces. */
export interface AgentDraft {
  domain: string;
  slug: string;
  spec: GeneratedAgentSpec;
  createdAt: string;
  /** Immutable delivery version which owns this draft. Older unversioned
   * drafts omit this field and are deliberately not regression-promotable. */
  versionId?: string;
  /** Pointer to the exact, replayable suite that approved this version. */
  regression?: {
    artifact: string;
    evidenceFingerprint: string;
    suiteFingerprint: string;
    cleanupReceiptHash: string;
    /** Exact authoritative Ontology snapshot identity that the sandboxed
     * delivery was generated and replayed against. Promotion must re-read the
     * bound source and match this digest; a live graph is never assumed stable. */
    authoritativeOntology: AuthoritativeOntologyEvidence;
  };
}

/** Secret-free identity of the normalized authoritative Ontology read at the
 * sandbox commit boundary. `contentHash` is produced by ontologyContentHash,
 * which treats graph collections as order-independent sets while preserving
 * every execution-bearing field. */
export interface AuthoritativeOntologyEvidence {
  schema: "agent-factory-authoritative-ontology/v1";
  tenantId: string;
  tenantSlug: string;
  domainId: string;
  source: DomainOntology["source"];
  contentHash: string;
}

/** Evidence copied into the immutable draft version when `finish` succeeds.
 * The store owns rendering modules and constructing executable replay cases;
 * the pure factory supplies only user-approved inputs and the exact green
 * sandbox identity. Cassette paths are references, never secret contents. */
export interface AgentDraftRegressionEvidence {
  evidenceFingerprint: string;
  /** Normalized authoritative Ontology identity captured only after the
   * disposable sandbox completed and the source was re-read without drift. */
  authoritativeOntology: AuthoritativeOntologyEvidence;
  /** Exact secret-free cleanup receipt from the fresh app that produced this
   * evidence. Legacy callers may omit it, but persistence/promotion fail
   * closed until a fresh sandbox run supplies one. */
  cleanupReceipt?: SandboxCleanupReceipt;
  /** Exact registration evidence copied from the green sandbox result. The
   * immutable regression artifact retains both manifest intent and the
   * broker's independent readback so promotion can re-audit the original gate. */
  sandboxAppId?: string;
  committedManifestFunctionIds?: string[];
  brokerRegistration?: SandboxBrokerRegistrationProof;
  /** External execution-plane attestation for this exact candidate/attempt. */
  executionReceipt?: import("./sandbox-execution-plane").SandboxExecutionPlaneReceipt;
  /** Attempt/bundle-bound real model usage. Provider raw responses and prompts
   * are never persisted in this evidence. */
  modelUsage?: import("./sandbox-model-usage").SandboxModelUsageEvidence;
  approvedTestCases: TestCase[];
  testCoverage?: { required: string[]; covered: string[]; backfilled: string[]; uncoveredNeedingData: string[] };
  testCoverageWaiver?: { cells: string[]; note?: string; confirmedAt: number };
  testDataOverrides?: Record<string, unknown>;
  boundaryEvents?: BoundaryEvent[];
  functionTester?: FunctionTesterEntry[];
  toolMode?: string;
  /** Runtime-authored full-Inngest dispatch evidence. Promotion rejects
   * legacy/unknown values instead of treating an absent counter as zero. */
  externalLiveCalls?: number | null;
  replayReceipts?: SandboxToolDispatchReceipt[];
  sandboxReplayEvidenceComplete?: boolean;
  /** Authenticated, server-consumed human approval for the exact candidate
   * fingerprint that was allowed to enter the disposable sandbox. Optional on
   * the port for legacy callers; immutable regression persistence fails closed
   * when it is absent or not bound to the current evidence tuple. */
  sandboxDesignReview?: {
    fingerprint: string;
    subjectDigest: string;
    receipt: FactoryHumanAuthorizationReceipt;
  };
  cassetteRefs?: Array<{
    bindingId?: string;
    specSlugs?: string[];
    tool: string;
    path: string;
    definitionHash?: string;
    schemaHash?: string;
    /** SHA-256 of the exact redacted cassette document at finish time. */
    contentHash?: string;
    evidenceMode?: "live-probe" | "signed-fixture" | "runtime-record";
    configHash?: string;
    attestationKeyId?: string;
    attestationExpiresAt?: string;
    writeProbe?: {
      schema: "agent-factory-write-probe/v1";
      createCompleted: boolean;
      cleanupCompleted: boolean;
      absenceVerified: boolean;
      idempotencyKeyHash: string;
    };
  }>;
}

/** Persists the agents the factory GENERATED as durable, reviewable DRAFTS — the OLD
 *  repo's syncDomainDrafts (which wrote draft AgentVersion rows). Without this port a
 *  finished run threw its agents away (they lived only in the transcript). With it,
 *  `finish` writes them so a completed run produces inspectable, promotable artifacts.
 *  Fail-closed by contract: an incomplete version or regression artifact must
 *  throw back into the finish gate so delivery is never reported as durable. */
export interface AgentDraftStore {
  /** Persist this run's accepted specs for the domain; returns how many were written. */
  save(domain: string, specs: GeneratedAgentSpec[], regression?: AgentDraftRegressionEvidence): Promise<number>;
  /** List a domain's persisted drafts (newest spec per slug). */
  list(domain: string): Promise<AgentDraft[]>;
}

/** The dependency-injection root the brain is constructed with. */
export interface FactoryPorts {
  /** Authenticated immutable owner of this factory execution. Profile scope
   * checks consume it at every execution-bearing gate. */
  factoryScope?: { tenantId: string; tenantSlug: string };
  ontology: OntologySource;
  sandbox: SandboxDeployer;
  conversation: ConversationStore;
  reflection: ReflectionWriter;
  /** optional: when absent, create_skill/use_skill are no-ops + web_search returns empty. */
  skills?: SkillStore;
  web?: WebSearch;
  /** optional: when absent, create_tool persists only in-run (still grounds design_agent). */
  tools?: ToolStore;
  /** optional: authenticated persistence surface used only after an exact
   * one-shot ask_user confirmation. */
  integrationProfiles?: IntegrationProfileStore;
  /** Server-owned one-shot challenge issuer/consumer. A model never receives
   * a method for manufacturing or marking these receipts consumed. */
  authorizationChallenges?: FactoryAuthorizationChallengeStore;
  /** Tenant/domain/conversation-scoped binary fixture storage. Raw bytes never
   * enter the model transcript or persisted TestCase payload; supply_test_data
   * stores only a content-addressed binding returned by this port. */
  fixtureAssets?: import("./test-fixture-assets").FactoryTestFixtureAssetReader;
  /** #CONV-ARCHIVE optional: durable verbatim archive of compaction-dropped conversation turns.
   * When configured, maybeCompact archives BEFORE folding and DEFERS the fold if the write fails
   * (silent loss is never an outcome); recall_conversation searches it on demand. Absent →
   * folds keep today's summary-only behavior. */
  conversationArchive?: import("./conversation-archive").FactoryConversationArchive;
  /** optional: the REAL global tool registry (@agentic/tools listGlobalTools), injected by the api
   *  so the pure factory package can recommend real tools (parseResumeApi, fs.*) by semantic rank
   *  even when the ontology declared none. Absent → falls back to ontology-declared tools only. */
  toolRegistry?: ToolRegistry;
  /** Platform-owned execution surfaces that are not dispatchable tools (for
   * example the host runtime's `reason` RPC) self-declare their exact
   * integration coverage and current availability through this port. */
  integrationCapabilities?: IntegrationCapabilityRegistry;
  /** optional: when absent, finish() doesn't persist drafts (agents live only in the
   *  transcript). When wired, a finished run writes durable, promotable agent drafts. */
  drafts?: AgentDraftStore;
  /** optional (#SCALE-TOOLS): record per-tool sandbox outcomes so ranking can demote empirically
   *  failing tools. No-op when unwired; fail-safe. */
  toolStats?: { record(toolName: string, ok: boolean): Promise<void>; successRates(): Promise<Record<string, { invoked: number; succeeded: number }>> };
  /** optional (P1-6): persist per-criterion acceptance verdicts so pass-rate can be trended without
   *  replaying transcripts. No-op when unwired; fail-safe (never throws into the finish gate). */
  acceptance?: AcceptanceRecorder;
  /** optional: the domain-analysis REPORT pipeline (reportGenerator agent → HTML/PDF artifacts).
   *  Wired by the api to report-jobs; when absent, generate_report refuses with a clear message
   *  (the brain must never hand-write a full report into the chat as a fallback). */
  report?: ReportRunner;
  /** optional: 系统 B 的舰队目录（已交付/已启用的 functions）——capability_resolve 的「复用面」。
   *  Wired by the api; absent → resolution honestly skips the fleet face (never guesses). */
  fleet?: FleetCatalog;
  /** optional (#POLICY-LEARN): per-domain 前置路由 arm 统计（(pipeline|band) → {n,ok,fidelityBad}）。
   *  conductor 选路前 load 做证据偏置、run 收束时 save。No-op when unwired; fail-safe. */
  policyStats?: {
    load(domain: string): Promise<Record<string, { n: number; ok: number; fidelityBad: number }> | null>;
    save(domain: string, stats: Record<string, { n: number; ok: number; fidelityBad: number }>): Promise<void>;
  };
  /** optional (#MEM-WRITE, Mem0 式写路径): 工厂长期记忆——按 domain 作用域读写。Wired by the api
   *  over the runtime's createMemoryHandle（agent_memory_long + 向量驱动——架构审计标记的"建成但
   *  零调用方"的写路径，本 port 即其复活点）。Absent → consolidation no-op; fail-safe. */
  memory?: FactoryMemoryPort;
  /** Human-confirmed decisions are written immediately at the HITL gate and
   * replayed into a fresh conversation.  Kept outside `memory` so no AI
   * consolidation operation can overwrite a pinned human fact. */
  humanMemory?: FactoryHumanMemoryStore;
  /** optional (#KNOW-PACK P1-A): 跨会话的领域分析包——understand_ontology 读穿/写穿。
   *  按本体内容哈希精确寻址：本体一变查询自然 miss（隐式失效）。Absent → 仅会话内 ctx
   *  缓存（今日行为）；一切钩子 best-effort，store 故障绝不影响工具本身。 */
  domainInsights?: DomainInsightStore;
  /** optional: authored System Profile alias groups — each inner array is a set of
   * equivalent external-system names treated as one identity during binding. */
  systemAliases?: { list(): Promise<string[][]> };
  /** optional: System Profiles flagged human-boundary — the WHOLE system is manually
   * handled (see collectExecutionResources in tools.ts; seeds mode:"all" boundaries). */
  systemHumanBoundaries?: { list(): Promise<string[]> };
}

/** #KNOW-PACK — one persisted domain-analysis pack: the fold-surviving understanding fields of
 *  BrainCtx（digest/mode/coverage/perspectives/ambiguityCount）snapshotted per ontology version.
 *  `perspectives` 与 BrainCtx.ontologyPerspectives 同构——载入必须还原它，包才保持「镜头感知」
 *  （#PERSPECTIVES-FIDELITY 缓存门依赖其存在性）。 */
export interface DomainInsightPack {
  domain: string;
  /** ontologyContentHash of the POST-HEAL working ontology（与 understand_ontology 的
   *  curUnderstandSig 同源），绝不是 read_ontology 的 pre-heal counts#hash。 */
  ontologySig: string;
  mode: "shallow" | "deep";
  digest: string;
  coverage?: { itemsAnalyzed: number; itemsTotal: number; batches: number; oversized: number; complete: boolean };
  perspectives?: {
    selected: Array<{ id: string; label: string; focus: string; adapted: boolean }>;
    okCount: number;
    total: number;
    source: "llm" | "fallback";
  };
  ambiguityCount?: number;
  updatedAt?: string;
}

export interface DomainInsightStore {
  load(domain: string, ontologySig: string): Promise<DomainInsightPack | null>;
  /** Upsert by (domain, ontologySig)。并发同 sig 写方产物等价——last-write-wins 正确、无锁；
   *  唯一例外：已有 deep 行时 shallow 不得降级覆盖（store 实现负责）。 */
  save(pack: Omit<DomainInsightPack, "updatedAt">): Promise<void>;
}

/** #MEM-GENERAL (P2) — 跨域通用记忆道的哨兵 subject。只运载【跨域方法论】（如"vendor 信封常嵌套
 *  两层"），永不运载域业务事实；领域分析包（#KNOW-PACK）永远严格 domain+hash 域内。api 端口对
 *  该哨兵豁免域校验；召回把它并入同帧并标 (通用)。 */
export const GENERAL_MEMORY_SUBJECT = "__general__";

/** #MEM-WRITE — domain-scoped long-term memory for the factory brain. The operation set mirrors
 *  Mem0 (arXiv 2504.19413): the consolidator retrieves semantically-near candidates, then an LLM
 *  chooses ADD/UPDATE/DELETE/NOOP per extracted fact — no separate classifier. */
export interface FactoryMemoryPort {
  search(domain: string, query: string, k: number): Promise<Array<{ key: string; value: string; score: number }>>;
  put(domain: string, key: string, value: string): Promise<void>;
  del(domain: string, key: string): Promise<void>;
}

/** A human-authored, domain-scoped decision.  This is deliberately separate
 * from the LLM-managed Mem0 store above: a consolidation pass must never
 * rewrite or delete a pinned fact that a person explicitly confirmed. */
export type FactoryHumanMemoryKind = "clarify" | "boundary" | "test_approval" | "directive";

export interface FactoryHumanMemory {
  id: string;
  domain: string;
  questionKey: string;
  kind: FactoryHumanMemoryKind;
  question: string;
  answer: string;
  context?: string;
  source: "human";
  conversationId?: string;
  confirmed: boolean;
  pinned: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface FactoryHumanMemoryStore {
  list(
    domain: string,
    opts?: { confirmedOnly?: boolean; pinnedOnly?: boolean; limit?: number },
  ): Promise<FactoryHumanMemory[]>;
  upsert(
    domain: string,
    memory: {
      questionKey: string;
      kind: FactoryHumanMemoryKind;
      question: string;
      answer: string;
      context?: string;
      /** Runtime-checked as well as type-checked by concrete stores. */
      source: "human";
      conversationId?: string;
      confirmed?: boolean;
      pinned?: boolean;
    },
  ): Promise<FactoryHumanMemory>;
  pin(domain: string, id: string, pinned: boolean): Promise<boolean>;
  del(domain: string, id: string): Promise<boolean>;
}

/** Delivered functions visible to the GENERATION system for reuse resolution (G1, 附录 B)。
 *  G2 回流飞轮：条目可携带近期【生产】运行战绩（prodRuns/prodFailRate，系统 B → 系统 A），
 *  capability_resolve 在复用判定旁展示，让"复用一个正在生产上翻车的 agent"当场可见。 */
export interface FleetCatalog {
  list(): Promise<Array<{ kebabId: string; name: string; title?: string; enabled: boolean; trigger: string[]; emit: string[]; prodRuns?: number; prodFailRate?: number }>>;
}

/** Starts/polls an ontology-analysis report job. Artifacts download at /v1/artifacts/:id and the
 *  job is visible in the portal's 后台任务 panel (report-jobs is the single implementation). */
export interface ReportRunner {
  start(opts: { domain: string; format: "html" | "pdf" | "both"; focus?: string; extraHtml?: string }): Promise<{ id: string }>;
  status(id: string): Promise<{
    status: "running" | "done" | "error";
    phase?: string;
    error?: string;
    note?: string;
    title?: string;
    artifacts: Array<{ id: string; kind: string; label: string; size: number }>;
  } | null>;
}

/** #P1-6 — records one row per acceptance criterion per run (for trend dashboards). */
export interface AcceptanceRecorder {
  record(runId: string, domain: string, tenantId: string | undefined, criteria: Array<{ key: string; label: string; pass: boolean; detail: string }>): Promise<void>;
}

/** The real global tool registry surfaced to the factory (config-injected, see FactoryPorts.toolRegistry). */
export interface ToolRegistry {
  list(): Promise<RealTool[]>;
}

/** Runtime/event infrastructure must be discoverable and freshness-checked in
 * the same way as tools; a prompt assertion is never integration evidence. */
export interface IntegrationCapabilityRegistry {
  list(): Promise<IntegrationCapabilityProvider[]>;
}
