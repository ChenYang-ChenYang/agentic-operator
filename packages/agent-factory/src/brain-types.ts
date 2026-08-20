// Autonomous Harness Brain — shared types (migrated + adapted for the new arch).
//
// The brain is a streaming ReAct loop: it reasons, calls tools, observes, loops.
// These are the streamed events (rendered live in the chatbot) + the tool contract.
// Adapted from the OLD lib/agent-factory-v3/brain/types.ts: the registry/prisma
// couplings are gone — the brain now depends only on the injected FactoryPorts.

import type { DomainOntology } from "./ontology-types";
import type { GeneratedAgentSpec } from "./spec-types";
import type {
  FactoryPorts,
  SandboxDeployResult,
  FactoryAutopilotSandboxReviewEvidence,
  FactorySignedFixturePreparation,
  FactorySignedFixtureRequest,
} from "./ports";
import type {
  FactoryAuthorizationChallenge,
  FactoryHumanAuthorizationReceipt,
  FactoryHumanMessage,
  FactoryHumanInteractionKind,
  FactoryPendingHumanInteraction,
} from "./authorization-challenge";
import type {
  SandboxEvidencePlanPreparation,
  SandboxEvidencePlanRequest,
} from "./sandbox-evidence-plan";
import type { RealTool } from "./tool-catalog";
import type { OntologyReadinessReport } from "./ontology-readiness";
import type { FunctionTestAssertions } from "./function-test-contract";
import type {
  FactoryGenerationDirective,
  FactoryInteractionPolicy,
} from "./generation-directive";

export type FactoryAssumptionGate =
  | "clarify"
  | "test_approval"
  | "sandbox_review"
  | "boundary";

export interface FactoryAppliedAssumption {
  id: string;
  gate: FactoryAssumptionGate;
  subject: string;
  value: string;
  source: "recommended" | "safe_default";
  detail?: string;
  appliedAt: number;
}

/** A generated agent, trimmed for the UI card. */
export type AgentCardLite = {
  slug: string;
  /** the ontology action this agent implements — the key score.delta/refine events use, so the
   *  UI can match a score to its node (slug/short are derived forms that never equal it). */
  actionName: string;
  short: string;
  nameZh: string;
  trigger: string[];
  emit: string[];
  tools: string[];
  /** tools the brain wanted but the library doesn't have yet (shown as "待人工实现"). */
  unresolved?: string[];
  /** TRUE = an invoke-only sub-agent (design_subagent) — the UI must not infer this from the
   *  slug (a top-level action whose kebab contains "-sub-" would be misclassified). */
  isSubAgent?: boolean;
};

/** The LLM's authored design for one agent — surfaced as collapsible reasoning. */
export type AgentDesignLite = {
  reasoning: string;
  systemPrompt: string;
  toolRationale: string;
  decisionLogic: string;
  code?: string;
  codeSource?: "ai" | "render";
  /** #REDESIGN FU3 — graded truly executable (CodeAct): compiled + AST-linted + load-probed. When
   *  false the runtime executes it declaratively; `probeReason` says why the code was rejected. */
  codeExecuted?: boolean;
  probeReason?: string;
};

/** An explicit plan artifact the brain produces after read_ontology and before
 *  per-agent design — lets it decompose once and replan if validation reveals a flaw. */
export type BuildPlan = {
  summary: string;
  agents: Array<{
    actionName: string;
    role: string;
    triggerEvents: string[];
    emitEvents: string[];
    toolCandidates: string[];
    edgeCases: string[];
  }>;
  notes: string[];
  version: number;
  /** #SCOPE — deliberate plan scope. "partial" = the USER asked for a subset of the ontology's
   * Agent actions (e.g. "只生成 createJD 的 function"); uncovered actions are then intent, not an
   * omission — create_plan stops warning about them and finish's full-coverage refusal routes to
   * save_draft instead. Absent/"full" keeps the original all-actions delivery semantics. */
  scope?: "full" | "partial";
  scopeReason?: string;
};

/** 4-dimension deterministic quality score for one spec (each 0-100). */
export type ScoreDims = {
  toolResolution: number;
  promptRichness: number;
  decisionCoverage: number;
  refineHealth: number;
};

/** One revision attempt on a single agent — stored in ctx.attemptHistory so
 *  refine_agent passes the prior spec + critique back instead of blind-overwriting,
 *  and revert_refine can roll back. */
export type RefineAttempt = {
  attemptNumber: number;
  priorSpecSnapshot: {
    systemPrompt: string;
    tools: string[];
    decisionLogic?: string;
  };
  /** #W1 — FULL deep snapshot of the prior spec (schemas/plan/code included) so revert_refine is a
   *  complete rollback, not the 3-field partial one that left half-reverted schema state. */
  fullSnapshot?: Record<string, unknown>;
  /** #W1 — this attempt's score delta, for convergence detection (two near-zero deltas → stop). */
  delta?: number;
  critique: string;
  changes: string;
};

/** A full-flow test case the brain authors before sandbox_run (pass/reject/edge) —
 *  one entry event + a real payload that exercises one path of the event graph. The
 *  user approves/regenerates before any real fire. */
export type TestCase = {
  id: string;
  name: string;
  scenario: string;
  kind: "pass" | "reject" | "edge" | "fault";
  entryEvent: string;
  payload: Record<string, unknown>;
  expectedOutcome: string;
  /** Exact declared event expected by a structured decision-table boundary
   * case. When set, sandbox grading checks this event rather than inferring
   * success/failure from its name. */
  expectedEvent?: string;
  /** Machine-readable coverage-matrix cell generated from the table row. */
  coverageCell?: string;
  /** Optional executable assertions persisted into the immutable regression
   * suite. Prose in expectedOutcome is never parsed into a test contract. */
  functionAssertions?: FunctionTestAssertions;
};

/** A boundary event = an event some agent EMITS but no INTERNAL agent consumes. Inngest
 *  events are global, so a consumer-less emit is often a legitimate handoff to an EXTERNAL
 *  platform / webhook / terminal — NOT a broken chain. The user classifies each. */
export type BoundaryEvent = {
  event: string;
  kind: "external" | "terminal" | "break";
  consumer?: string; // external: which platform/service/team consumes it
  payloadContract?: string; // external: the payload the consumer should expect
  note?: string;
};
/** The brain's proposed classification for a dangling event, shown on the decision card. */
export type BoundaryProposal = {
  event: string;
  suggestedKind: "external" | "terminal" | "break";
  why: string;
  producers: string[];
  consumer?: string;
  payloadContract?: string;
};

/** Per-agent REAL I/O after a sandbox settles — the evidence the verification panel
 *  shows (real runId + real payloads, not a paper claim). */
export type AgentRunIO = {
  agentSlug: string;
  agentShort: string;
  status: string;
  degraded: boolean;
  triggerEvent: string | null;
  inputPayload: Record<string, unknown> | null;
  tools: string[];
  outputEvent: string | null;
  reasoning: string;
  outputPayload: Record<string, unknown> | null;
  runId: string;
  url?: string;
};

/** A reflection persisted via analyze_failure, loaded on the next run for the domain. */
export type ReflectionLite = {
  kind: "failure" | "success" | "caveat";
  summary: string;
  rootCause?: string;
  lesson: string;
  createdAt: string;
};

/** The 6 canonical factory pipeline stages — drives the live-canvas stage rail and the
 *  always-visible health/progress strip. The conductor emits an explicit `stage` event on
 *  each stage-bearing tool; the web client also infers a fallback from `event.t` so runs
 *  recorded before stage events existed (and sub-agent runs) still light the rail. */
export type FactoryStage =
  | "read"
  | "plan"
  | "design"
  | "validate"
  | "sandbox"
  | "deliver";

/** Streamed to the chatbot — the live trace of model output + explicit acts. */
export type BrainEvent =
  /** Legacy wire name for ordinary streamed assistant content, not hidden CoT. */
  | { t: "think"; delta: string }
  // #UI-DRILL — `forAgent` is the actionName of the generated agent this harness step is FOR
  // (from the tool's `action`/`parent_action` arg), so the ops panel can group every reasoning
  // step, tool call and sub-agent under the agent it was building (macro→micro drill-in).
  | {
      t: "tool.call";
      id: string;
      name: string;
      reasoning: string;
      input: unknown;
      role?: string;
      forAgent?: string;
    }
  // #HEARTBEAT — 长工具执行心跳（每 ~15s）：用户永远能区分「慢/卡/死」——elapsedS 递增 = 还在
  // 干活；note 是升级提示（60s/180s/420s 各一条）。同时让 SSE 持续有事件流出，前端 staleness
  // 检测不再把长工具误判成"已无响应"。阻断必有回执的第一层。
  | {
      t: "tool.progress";
      id: string;
      name: string;
      role?: string;
      elapsedS: number;
      note?: string;
    }
  | {
      t: "tool.result";
      id: string;
      name: string;
      ok: boolean;
      summary: string;
      output?: string;
      forAgent?: string;
    }
  | {
      t: "agent.created";
      spec: AgentCardLite;
      design?: AgentDesignLite;
      forAgent?: string;
      parentAgent?: string;
    }
  | {
      t: "catalog";
      domain: string;
      actions: number;
      events: number;
      agentActions: number;
    } // read_ontology summary
  | { t: "plan"; plan: BuildPlan }
  | {
      t: "validation";
      ok: boolean;
      issues: string[];
      agentIssueMap?: Record<string, unknown[]>;
    }
  // #BIZFLOW — the derived end-to-end business-flow model (external platforms + per-agent
  // reads/calls/writes/notifies + branch semantics). The right sidebar renders this as the
  // complete business-flow diagram (the hand-drawn 6-agent SVG, generated). Typed loosely here
  // to avoid a type-only import cycle; the shape is business-flow.ts#BusinessFlowModel.
  | { t: "flow.business"; model: Record<string, unknown> }
  // #BLUEPRINT — an AI-reasoned, ONTOLOGY-GROUNDED phased workflow/business-flow/agent blueprint.
  // Each phase/step carries ontology anchors (entity/action/rule/event id); anything that could not
  // be grounded is recorded in `model.unresolved` (fail-closed, never invented). `diagrams[]` carry
  // pre-rendered deterministic SVG. The UI renders it as the "蓝图" panel. Shape = blueprint.ts#BlueprintModel.
  | { t: "flow.blueprint"; model: Record<string, unknown> }
  // #USER-MESSAGE — what the HUMAN said, as a first-class transcript frame: the goal that started
  // a run, a message injected into a live brain, a HITL gate answer. The chat UI renders it as the
  // user's bubble so the conversation reads as a dialogue, not an assistant monologue. Emitted by
  // the run registry / inject route (control-plane resume steers are deliberately NOT emitted).
  | { t: "user.message"; text: string }
  /** Server-validated generation scope. This is emitted before the brain starts
   * so reconnect/replay can always explain which authoritative Action ids (or
   * scenario overlay) the run was allowed to implement. */
  | {
      t: "source.scope";
      schema: "agent-factory-source-scope/v1";
      domain: string;
      mode: FactoryGenerationDirective["mode"];
      actionIds: string[];
      actionNames: string[];
      actions: Array<{ id: string; name: string }>;
      sourceOntologyHash: string;
      scenario?: string;
    }
  /** Non-authoritative Action synthesized from an FDE scenario. The event is
   * provenance only; it never grants tools, credentials, side effects, or
   * permission to write the source Ontology. */
  | {
      t: "virtual_action.created";
      schema: "agent-factory-virtual-action/v1";
      actionId: string;
      name: string;
      trigger: string[];
      emit: string[];
      scenario: string;
      provenance: NonNullable<
        FactoryGenerationDirective["virtualAction"]
      >["factoryProvenance"];
    }
  // #POLICY — the entrance router's decision (why this pipeline shape / specialist depth / tier
  // bias was selected for THIS request). Emitted right after the intent gate; UI renders it as
  // the "推理策略" chip so the choice is explainable, not implicit.
  | {
      t: "policy";
      pipeline: string;
      strategy?: string;
      band: string;
      deepUnderstand: boolean;
      deepCritique: boolean;
      tierBias?: string | null;
      reasons: string[];
    }
  // #STRATEGY-COMBO — AI 就某子问题自选的推理方法【组合】(单个或 tot→debate→reflection 之类)。
  | {
      t: "strategy";
      mode: "single" | "combo";
      steps: string[];
      chosenBy: "ai" | "default";
      rationale: string;
      forAgent?: string;
    }
  // #REASONING-KERNEL — a single step of a strategy plan ACTUALLY executing (not just declared): the
  // reasoning kernel ran this method (cot/reflection/debate/tot/react) and produced this output. A combo
  // emits one per step in order; the UI can show the real deliberation, not just a label.
  | {
      t: "reasoning.step";
      strategy: string;
      index: number;
      total: number;
      output: string;
      forAgent?: string;
      meta?: Record<string, unknown>;
    }
  // #REVISION — 证据驱动的本体修订提案（真实沙箱载荷 vs canonical event_data 持续不一致）。
  // 工厂只提案不写回；大脑据此 ask_user 确认（"AI 提案 → 人确认 → 生效"，同 boundary-gate 范式）。
  | {
      t: "ontology.revision";
      proposals: Array<{
        kind: string;
        event: string;
        field: string;
        observedType: string;
        canonicalType?: string;
        occurrences: number;
        evidence: string;
      }>;
    }
  // #ONTOLOGY-HEAL — deterministic self-consistency normalization applied while reading (for
  // example, a uniquely implied primary key). Model-authored revision proposals never emit this
  // event and cannot mutate the working copy.
  | {
      t: "ontology.heal";
      changes: Array<{ code: string; detail: string }>;
      source: "auto";
      blockingBefore?: number;
      blockingAfter?: number;
    }
  | {
      t: "sandbox";
      ran: number;
      reachedTerminal: boolean;
      reachedSuccessTerminal?: boolean;
      agents: string[];
      events: string[];
      appId?: string;
      functionsRegistered?: number;
      /** Legacy UI field. New runs place the committed manifest IDs here for
       * display; independent broker proof is evaluated separately. */
      registeredIds?: string[];
      /** #REDESIGN P1a — spec shorts whose GENERATED CODE actually EXECUTED (真跑, not fell back). */
      codeRanAgents?: string[];
      deployed?: number;
      fullChainRan?: boolean;
      deployFailed?: boolean;
      degradedAgents?: string[];
      /** #D — how the chain closed: N internal chains + M legitimate external-handoff terminals. */
      internalChains?: number;
      externalTerminals?: number;
      /** External callbacks that lacked an explicit approved test case/payload, so no dispatch ran. */
      uncoveredExternalInputs?: string[];
      runUrls?: Array<{
        runId: string;
        url: string;
        status: string;
        fn: string;
      }>;
      /** per-agent REAL I/O captured after the run settled (Feature: agent-io). */
      agentRuns?: AgentRunIO[];
      /** the approved test cases that were fired (Feature: test-case loop). */
      cases?: Array<{
        name: string;
        entryEvent: string;
        payload: Record<string, unknown>;
      }>;
      /** #W3-FAULT — per-fired-case verdict by KIND (pass/reject/edge/fault). A fault case PASSES
       *  precisely when the chain REFUSED to reach a success terminal under an injected tool fault
       *  (proving error propagation, not silent success). Surfaced as per-kind verdict chips. */
      caseVerdicts?: {
        allPass: boolean;
        results: Array<{
          caseId?: string;
          kind: string;
          pass: boolean;
          reason: string;
        }>;
        byKind: Record<string, { total: number; passed: number }>;
      };
      /** TRUE = a graph-closure SIMULATION, not a real Inngest deploy+run. The UI must
       *  badge it so a simulated pass is never mistaken for a verified real deploy. */
      simulated?: boolean;
      /** #R3 — spec shorts whose REAL emitted payload violated the downstream contract. */
      fidelityFailures?: string[];
    }
  | {
      t: "refine";
      actionName: string;
      critique: string;
      diff?: {
        systemPromptChanged: boolean;
        toolsAdded: string[];
        toolsRemoved: string[];
        decisionLogicChanged: boolean;
        planChanged?: boolean;
      };
    }
  | {
      t: "score.delta";
      actionName: string;
      priorTotal: number;
      newTotal: number;
      delta: number;
      regression: boolean;
      dimensions: ScoreDims;
    }
  | { t: "revert"; actionName: string; revertedToAttempt: number }
  | {
      t: "inspect";
      runId: string;
      agentSlug: string;
      status: string;
      degraded?: boolean;
      error?: string;
    }
  | { t: "skill.created"; name: string; purpose: string }
  | {
      t: "tool.created";
      name: string;
      description: string;
      /** Exact immutable ledger identity when the tool was durably authored. */
      revisionId?: string;
      /** `ephemeral` is restricted to non-persistent harness/test wiring. */
      status: "draft" | "active" | "retired" | "rejected" | "ephemeral";
      /** Honest runtime truth: drafts and ephemeral descriptors are never active. */
      runtimeActive: boolean;
    }
  | {
      t: "tool.search";
      query: string;
      results: Array<{ name: string; summary: string; sideEffect: string }>;
    } // progressive tool discovery
  | {
      t: "tool.schema";
      name: string;
      method: string;
      url: string;
      fields: number;
    } // doc→tool schema extracted
  | {
      t: "web.result";
      query: string;
      results: Array<{ title: string; url: string; snippet: string }>;
    }
  | {
      t: "subagent.start";
      task: string;
      role?: string;
      parentAgent?: string;
      groupId?: string;
    }
  | {
      t: "subagent.done";
      task: string;
      summary: string;
      parentAgent?: string;
      groupId?: string;
    }
  // #SUBAGENT-GROUP — a reasoning-driven group of sub-brains fanned out by spawn_subagent_group, each a
  // member that runs its OWN runBrain loop; the pair brackets the members so the UI can render a tree.
  | {
      t: "group.start";
      groupId: string;
      label: string;
      members: number;
      mode: "research" | "build" | "design" | "review" | "refine";
    }
  | {
      t: "group.done";
      groupId: string;
      label: string;
      ok: number;
      total: number;
      summary: string;
    }
  | { t: "code"; actionName: string; code: string; codeSource: "ai" | "render" }
  // Explicit pipeline-stage signal. status: "active" = the brain entered/is working this
  // stage; "ok"/"error" = its tool settled. Drives the live-canvas stage rail + health strip
  // directly, instead of every consumer re-inferring a stage from heterogeneous event types.
  | {
      t: "stage";
      role?: string;
      stage: FactoryStage;
      status: "active" | "ok" | "error";
      detail?: string;
    }
  // #CHECKLIST — the harness-owned acceptance checklist snapshot, emitted on every finish attempt
  // (pass or fail). criteria = fleet-level bar; perAgent = per-agent items derived from the same
  // evidence. The UI renders this as a checklist the brain cannot edit — items flip green only via
  // real execution evidence.
  | {
      t: "acceptance";
      allPass: boolean;
      criteria: Array<{
        key: string;
        label: string;
        pass: boolean;
        detail: string;
      }>;
      perAgent: Array<{
        slug: string;
        short: string;
        pass: boolean;
        items: Array<{
          key: string;
          label: string;
          pass: boolean;
          detail: string;
        }>;
      }>;
    }
  | {
      t: "test.cases";
      cases: TestCase[];
      awaitingApproval: boolean;
      interactionId?: string;
      coverage?: {
        required: string[];
        covered: string[];
        backfilled: string[];
        uncoveredNeedingData: string[];
      };
    }
  | {
      t: "test.decision";
      decision: "approve" | "regenerate" | "supply_data" | "save_draft";
      interactionId?: string;
      note?: string;
    }
  // Boundary events the brain proposes for the user to classify (external handoff /
  // terminal / break). awaitingDecision=true → the conductor is PARKED for the choice.
  | {
      t: "boundary.cases";
      proposals: BoundaryProposal[];
      awaitingDecision: boolean;
      interactionId?: string;
    }
  | { t: "boundary.decided"; events: BoundaryEvent[]; interactionId?: string }
  | {
      t: "assumption.applied";
      assumption: FactoryAppliedAssumption;
      /** Compact replay/UI label; the full audited record remains above. */
      summary?: string;
    }
  // ask_user: a general clarification the brain raises when uncertain / missing info. The
  // conductor PARKS (awaitingAnswer) until the user supplies a free-text answer or picks an
  // option (one may be the AI's recommendation). Keeps generation flexible, not rigid.
  | {
      t: "clarify";
      question: string;
      options?: Array<{ label: string; value: string; recommended?: boolean }>;
      /** Structured source for ask_user_batch; question stays for transcript/back-compat. */
      items?: Array<{
        question: string;
        context?: string;
        options?: Array<{
          label: string;
          value: string;
          recommended?: boolean;
        }>;
      }>;
      context?: string;
      awaitingAnswer: boolean;
      interactionId?: string;
    }
  | { t: "reflect"; kind: string; lesson: string; count?: number }
  // #7 — which model served this turn + the difficulty tier it was routed to (annotated in the
  // activity log). The router picks fast/default/hard from the live context, config-driven.
  | {
      t: "model";
      model: string;
      tier: string;
      turn: number;
      provider?: string;
      route?: string;
      /**
       * Whether the tenant's allowed routes could actually serve this tier.
       * `false` means an allowed model ran that was NOT the requested
       * difficulty — stated on the receipt rather than passed off as a normal
       * turn, with `preferenceReason` carrying why.
       */
      preferenceSatisfied?: boolean;
      preferenceReason?: string;
    }
  | {
      t: "budget";
      turn: number;
      maxTurns: number;
      /** Tokens charged by provider usage during this run invocation only. */
      tokens: number;
      /** Checkpointed spend across the full resumable conversation. */
      conversationTokens?: number;
      maxTokens: number | null;
      specsBuilt: number;
      sandboxRuns?: number;
      level?: "ok" | "elevated" | "high";
      costNote?: string;
      /** Present when a pre-call reserve/headroom gate stopped the run. */
      stopReason?: string;
    }
  | { t: "message"; text: string } // the brain's narration / final answer
  // #2d — auto-compaction made visible: `summary` is the one-line notice, `state` is the full
  // structured snapshot that was folded, rendered behind an expand toggle in the transcript.
  | { t: "compaction"; summary: string; state: string }
  // Only "finished" (finish PASSED the acceptance gate) is success; everything else
  // is a failed/incomplete run so a budget/turn-exhausted/errored run never reads green.
  | {
      t: "done";
      /** Provider tokens spent by this run invocation, excluding resume history. */
      tokensUsed: number;
      /** Provider tokens accumulated by the resumable conversation. */
      conversationTokensUsed?: number;
      turns: number;
      status:
        | "finished"
        | "budget_exhausted"
        | "turns_exhausted"
        | "errored"
        | "incomplete"
        | "waiting_human";
      /** Distinguishes a complete informational answer from an unfinished
       * generation. The registry must never infer success from zero new agent
       * events: resumed conversations can already contain generated specs. */
      completionKind: "delivery" | "answer" | "incomplete";
    }
  | {
      t: "error";
      message: string;
      /** True only when the terminal failure came from a transient upstream
       * condition and replaying the durable conversation is safe. */
      retryable?: boolean;
    };

/** Trusted control-plane continuation reason. This is deliberately separate
 * from the user's goal text: a caller cannot obtain recovery semantics by
 * typing a magic prefix into an ordinary request. */
export type BrainContinuationMode = "crash_resume" | "human_gate_resume";

export type BrainEmit = (e: BrainEvent) => void;

export interface BrainToolResult {
  ok: boolean;
  /** one-line result the model sees + the UI shows */
  summary: string;
  /** structured payload fed back to the model as the tool result */
  output?: unknown;
}

/** The brain's working state for a run. Carries the injected ports + accumulated
 *  artifacts. Serializable subset (everything except `emit`/`ports`/`signal`) is what
 *  the ConversationStore persists so a follow-up message resumes mid-build. */
export interface BrainCtx {
  domain: string;
  goal: string;
  emit: BrainEmit;
  ports: FactoryPorts;
  /** `strict` is the legacy Factory behavior. OntoCode explicitly opts into
   * autopilot; authorization/credential/side-effect gates remain hard. */
  interactionPolicy?: FactoryInteractionPolicy;
  /** Server-validated generation scope plus an optional virtual Action
   * overlay. Persisted with the conversation, never written to Ontology. */
  generationDirective?: FactoryGenerationDirective;
  /** Auditable automatic recommendations/defaults adopted by autopilot. */
  assumptions?: FactoryAppliedAssumption[];
  /** accumulated generated specs (design_agent appends here) */
  specs: GeneratedAgentSpec[];
  /** cached after read_ontology */
  ontology: DomainOntology | null;
  /** Successful, sanitized `read_action_contract` results keyed by the exact
   * Ontology content hash + Action name. The cache is part of the durable
   * conversation state so compaction/resume cannot make the brain pay for and
   * execute the same authoritative read again. A different Ontology hash is
   * always a miss. */
  actionContractReads?: Array<{
    ontologyHash: string;
    actionName: string;
    sliceHash?: string;
    summary: string;
    output?: unknown;
    cachedAt: number;
  }>;
  /** Executable-contract verdict produced by read_ontology. A successful fetch
   * is not the same thing as a generation-ready Ontology. */
  ontologyReadiness?: OntologyReadinessReport;
  /** #4 — signature of the ontology at first read (counts), so a mid-run re-read can flag drift
   *  (the Allmeta graph changed under already-built specs) instead of silently swapping ground truth. */
  ontologySig?: string;
  budget: {
    maxTokens: number | null;
    maxTurns: number;
    /** Optional per-run cap on admitted, non-cached tool executions. Rejected
     * proposals do not consume it. Older checkpoints without this field keep
     * the legacy uncapped behavior. */
    maxToolCalls?: number;
  };
  /**
   * Server-owned absolute budget bound to one durable product execution.
   *
   * The private generation kernel normally treats a resumed checkpoint's
   * budget as a ceiling that callers may only tighten. OntoCode is different:
   * a later, explicitly authorized Job in the same stable Build execution may
   * carry a larger absolute allowance. This binding lets that control plane
   * widen the absolute ceiling monotonically without resetting `spent`, while
   * preventing another execution from adopting the checkpoint.
   */
  executionBudgetBinding?: {
    schema: "factory-stable-execution-budget/v1";
    stableExecutionId: string;
    maxTurns: number;
    maxToolCalls: number;
  };
  spent: {
    tokens: number;
    turns: number;
    sandboxRuns: number;
    /** Non-cached tool executions admitted by the conductor. Rejected model
     * proposals and cache observations do not consume this budget. Persisted
     * so a resumed conversation cannot reset the control-plane cap. */
    toolCalls?: number;
    /** #W2-STAGE — token spend attributed to the current pipeline stage (admission-gated state machine). */
    stageTokens?: Record<string, number>;
  };
  /** explicit BuildPlan (create_plan sets it; design/refine read it). */
  currentPlan: BuildPlan | null;
  /** #SCOPE — resolved plan scope (create_plan sets it): which ontology Agent actions the user
   * deliberately left out. finish reads it to route partial deliveries to save_draft. */
  planScope?: {
    kind: "full" | "partial";
    reason?: string;
    missedActions: string[];
  };
  /** #HUMAN-BOUNDARY — integration gaps the human confirmed as deliberate manual boundaries via a
   * clarify card. Written ONLY by the conductor while consuming a [澄清回答] (server-side; the model
   * never writes it); persisted with the conversation snapshot so resumes don't re-ask. Design
   * admits these as status:"human_boundary" bindings; sandbox/finish/promotion stay fail-closed. */
  integrationHumanBoundaries?: import("./integration-binding").IntegrationHumanBoundary[];
  /** The exact (system, mode) pairs the CURRENT integration clarify card asked about — recorded by
   * the asking tool, consumed + cleared by the conductor when the human answers. */
  pendingIntegrationBoundaryAsk?: Array<{ system: string; mode: string }>;
  /** Requirement-scoped integration choices accepted only from exact,
   * server-issued option tokens. The ontology hash prevents a choice from
   * surviving contract drift. */
  integrationSelections?: import("./integration-binding").IntegrationBindingSelection[];
  /** Server-owned candidates behind the current integration selection card.
   * The model cannot author or directly commit this state. */
  pendingIntegrationSelectionAsk?: import("./integration-binding").PendingIntegrationSelectionAsk;
  /** Canonical names from the current executable registry only. Source
   * Ontology symbols are deliberately excluded and live in
   * `sourceDeclarations`. */
  toolCatalog: string[];
  /** Source-authored Ontology tool symbols evaluated against the final bounded
   * execution projection. These are provenance/readiness facts, not an
   * executable tool catalog. */
  sourceDeclarations?: import("./execution-tool-projection").OntologyToolSourceDeclaration[];
  /** #C — the REAL global tools (name/summary/configKeys), loaded from ports.toolRegistry at
   *  read_ontology, so the brain can be recommended real tools by semantic rank + told what config
   *  to supply, even when the ontology declared none. */
  realTools?: RealTool[];
  /** Design-time rule grounding resolved only from exact
   * `action_steps[].rules` IDs/names. Ambiguous or missing references are
   * surfaced for ask_user instead of being inferred from prefixes or text. */
  rulesByAction?: Record<
    string,
    Array<{ id: string; name: string; summary: string }>
  >;
  /** per-action refinement history (refine snapshots + critiques; read by refine/revert/read_spec). */
  attemptHistory: Record<string, RefineAttempt[]>;
  /** #W2-HITL — human messages drained but TAGGED for a different gate: re-queued here so the right
   *  gate consumes them next tick instead of the wrong gate eating (and mis-parsing) them. */
  pendingHuman?: FactoryHumanMessage[];
  /** One opaque, one-shot identity per pending gate kind. Multiple kinds may
   * coexist in a restored checkpoint; priority is resolved separately. */
  humanInteractions?: Partial<
    Record<FactoryHumanInteractionKind, FactoryPendingHumanInteraction>
  >;
  /** Recent durable mailbox deliveries already represented by a conversation checkpoint.
   *  Retained across restart so an interrupted ack can be completed without replaying input. */
  checkpointedHumanDeliveries?: string[];
  /** skills the brain authored this run (woven into generated agents). */
  createdSkills: Array<{
    name: string;
    purpose: string;
    promptFragment: string;
    tools: string[];
    decisionRule: string;
  }>;
  /** facts gathered via web_search (fed into agent prompts as grounding). */
  research: Array<{ query: string; findings: string }>;
  /** test cases the brain authored (generate_test_cases); fired by sandbox_run after approval. */
  testCases?: TestCase[];
  /** Latest deterministic coverage matrix for the proposed suite. */
  testCoverage?: {
    required: string[];
    covered: string[];
    backfilled: string[];
    uncoveredNeedingData: string[];
  };
  /** Explicit human waiver for data-dependent cells. Bound to the exact cell
   * list; regenerating cases clears it. */
  testCoverageWaiver?: {
    cells: string[];
    note?: string;
    confirmedAt: number;
  };
  /** real values the USER supplied (supply_test_data) to replace demo placeholders for contact /
   *  credential / id fields (e.g. a real interview email) — applied into the fired test payloads. */
  testDataOverrides?: Record<string, unknown>;
  /** true while parked waiting for the user's 执行/重新生成 decision on the test cases. */
  awaitingApproval?: boolean;
  /** User chose to supplement the still-unapproved suite. While true the
   * conductor admits only test-data tools; sandbox_run/finish remain blocked
   * by awaitingApproval until the edited suite is reviewed again. */
  testDataSupplementPending?: boolean;
  /** One-shot, server-issued budget grant for an explicit fixture-clarification
   * exit into a generated_unverified handoff. Only save_draft may consume an
   * available grant; it never widens sandbox/finish/promotion admission and is
   * persisted so retry/resume cannot mint a fresh execution budget. */
  draftOnlyHandoffBudgetGrant?: "available" | "consumed";
  /** boundary events the user CLASSIFIED (external handoff / terminal / break) — graph
   *  validation honors external + terminal so they aren't false-flagged as broken chains. */
  boundaryEvents?: BoundaryEvent[];
  /** true while parked for the user's boundary-event decision (`[边界事件决策…]`). */
  awaitingBoundary?: boolean;
  /** ask_user park: true while waiting for the user's clarification answer. The prompt is
   *  retained across suspension/resume; a recommended option never substitutes for consent. */
  awaitingClarify?: boolean;
  /** #ASK-PROPOSAL — `proposal` 是提问那一刻大脑自己写的【提案原文】（同一轮 assistant 正文）。
   *  必须快照：选项常常只活在这段散文里（"路线A：只生成 createJD ／ 路线B：补齐全部 6 个"），
   *  `options` 是可选的、自动挂起路径更是完全没有 options。不留原文，用户的回答就退化成一个
   *  无法解析的字母（"用户回答：A"），大脑只能瞎猜 A 指什么——真实事故正是这么发生的。 */
  clarifyPrompt?: {
    question: string;
    options?: Array<{ label: string; value: string; recommended?: boolean }>;
    items?: Array<{
      question: string;
      context?: string;
      options?: Array<{
        label: string;
        value: string;
        recommended?: boolean;
      }>;
    }>;
    context?: string;
    proposal?: string;
  };
  /** #ASK-DEDUP — normalized question → the user's answer ("" while pending). ask_user refuses
   *  to re-ask an already-answered question (the answer is replayed to the brain instead). */
  askedQuestions?: Record<string, string>;
  /** Exact responder evidence for the current clarification answer. Ordinary
   * de-dup uses `askedQuestions`; authorization additionally requires this
   * authenticated, question/context-exact record. */
  clarificationAnswerEvidence?: Record<
    string,
    {
      question: string;
      context?: string;
      options?: Array<{ label: string; value: string; recommended?: boolean }>;
      answer: string;
      actor?: string;
      answeredAt: number;
    }
  >;
  /** Server-issued challenges waiting for an exact human answer. */
  pendingAuthorizationChallenges?: Record<
    string,
    FactoryAuthorizationChallenge
  >;
  /** Secret-free, exact signed-fixture proposals parked behind a durable
   * one-shot challenge. The API re-resolves definition/config before signing;
   * this checkpoint merely lets a resumed Brain repeat the reviewed bytes
   * instead of regenerating timestamps or fixture entries. */
  pendingSignedFixtureProposals?: Record<
    string,
    {
      request: FactorySignedFixtureRequest;
      preparation: FactorySignedFixturePreparation;
    }
  >;
  /** Exact multi-binding sandbox evidence plans waiting behind one durable
   * server challenge. Any binding/config/exchange/use/expiry change produces a
   * different key and therefore cannot consume the parked confirmation. */
  pendingSandboxEvidencePlanProposals?: Record<
    string,
    {
      request: SandboxEvidencePlanRequest;
      preparation: SandboxEvidencePlanPreparation;
    }
  >;
  /** Server-consumed, authenticated sign-off for exactly one current sandbox
   * evidence tuple. A changed fingerprint or runtime build identity makes it
   * unusable and forces a fresh review. */
  sandboxDesignReview?: {
    fingerprint: string;
    subjectDigest: string;
    receipt: FactoryHumanAuthorizationReceipt;
  };
  /** One-shot write-probe approvals already consumed in this conversation.
   * Persisted with the checkpoint so a repeated tool call cannot reuse them. */
  consumedProbeAuthorizationDigests?: string[];
  /** One-shot integration-profile confirmations already consumed in this
   * conversation. Persisted with the checkpoint and never reused as memory. */
  consumedIntegrationProfileAuthorizationDigests?: string[];
  /** #AUDIT-FIX(H4) — 本会话已成功交付过（finish 通过）。跨 run 持久（serializeCtx），
   *  完成守卫据此不再对交付后的追问轮催「去 finish」。 */
  delivered?: boolean;
  /** #POLICY — the entrance reasoning policy selected after the intent gate (pipeline shape +
   *  forced specialist depth + tier bias). Additive: size heuristics still apply independently.
   *  #OPEN-VOCAB：pipeline 是开放词汇——已知 full/skinny/analyze/ask_first 给路由规则；
   *  新形状原样携带，消费端未识别按 full 兜底（认知开放、协议封闭）。 */
  policy?: {
    pipeline: string;
    /** #STRATEGY — 轴2 默认推理策略（react/reflection/debate/tot/cot，开放词汇）。 */
    strategy?: string;
    deepUnderstand: boolean;
    deepCritique: boolean;
    tierBias: "fast" | null;
    reasons: string[];
    /** 难度带（policy-learning 的 arm 维度之一；run 收束时随 outcome 回喂）——度量刻度，保持封闭。 */
    band?: "simple" | "standard" | "complex";
  };
  /** #REASONING-KERNEL — the intent-derived DEFAULT reasoning method for this run (executed via the
   *  kernel, not react-by-default). "cot" for analyze/question/report answers; "react" (ambient tool
   *  loop) for generate/modify. Drives the top-level answer routing + prompt guidance. */
  reasoningDefault?: string;
  /** the proposals awaiting decision, kept so a park TIMEOUT can auto-apply the AI's kinds. */
  boundaryProposals?: BoundaryProposal[];
  /** outcome of the last sandbox_run — the finish gate requires real end-to-end
   *  evidence, tied to the exact specs via fingerprint so a changed spec can't
   *  finish on stale-green evidence. */
  lastSandbox: {
    /** Historical field name retained for persisted-context compatibility. Since evidence v2 this
     * is the canonical sandbox-evidence fingerprint (specs + tests/overrides + ontology + selected
     * tool bindings/config), not a specs-only hash. */
    specsFingerprint: string;
    deployed: number;
    agentsRan: number;
    ranAgents: string[];
    reachedTerminal: boolean;
    reachedSuccessTerminal: boolean;
    fullChainRan: boolean;
    /** Exact approved-suite identity and per-case runtime verdicts used only
     * as the strict timing fallback when fullChainRan has not settled yet. */
    caseVerdicts?: import("./acceptance").CompleteSuiteVerdicts;
    expectedCaseIds?: string[];
    /** #REDESIGN P1 — spec shorts whose generated code actually executed (not fell back). */
    codeRanAgents?: string[];
    degradedAgents: string[];
    /** #R3 — spec shorts whose REAL emitted payload violated the downstream field contract
     *  (evaluateExecutionFidelity over the sandbox agentRuns). Undefined ⇒ not graded ⇒ lenient. */
    fidelityFailures?: string[];
    /** R2: true = graph-closure SIMULATION (Inngest not reachable), not a real deploy+run.
     *  The finish gate always refuses it outside an isolated unit-test waiver. */
    simulated: boolean;
    /** #TESTER-WIRE — per-spec P2.5 function-tester verdicts (rendered .ts deliverable really
     *  executed in isolation). Undefined ⇒ not evaluated ⇒ acceptance UNKNOWN-blocks on real runs. */
    functionTester?: import("./ports").FunctionTesterEntry[];
    /** #TESTER-WIRE — sandbox chain tool dispatch mode (mock/replay/live/gated), for honest verdicts. */
    toolMode?: string;
    /** Fingerprint-bound proof of whether this exact spec set contains any
     * external-write tool. `false` permits gated mode only because every
     * dispatched integration is read-only/live. */
    externalWritesRequired?: boolean;
    /** Whether the latest real sandbox attempt proved broker registration/readiness and accepted
     * every entry-event dispatch. `false` invalidates any carried same-fingerprint success. */
    transportAccepted?: boolean;
    /** Latest transport diagnostic, retained for the finish gate/operator instead of being hidden by
     * an older successful snapshot for the same spec fingerprint. */
    transportError?: string;
    /** Manifest intent and independent Inngest registry observation. */
    appId?: string;
    committedManifestFunctionIds?: string[];
    brokerRegistration?: import("./ports").SandboxBrokerRegistrationProof;
    /** Fresh, content-addressed proof that the exact ephemeral Inngest app for
     * this attempt was deleted and read back as absent. */
    cleanupReceipt?: import("./ports").SandboxCleanupReceipt;
    /** Remote execution-plane attestation for the exact generated bundle. A
     * production finish never accepts a worker/process-only sandbox result. */
    executionReceipt?: import("./sandbox-execution-plane").SandboxExecutionPlaneReceipt;
    /** Real semantic-model calls; externalLiveCalls below counts tools only. */
    modelUsage?: import("./sandbox-model-usage").SandboxModelUsageEvidence;
    candidateFingerprint?: string;
    targetDomainId?: string;
    sandboxAttemptId?: string;
    sandboxTenantSlug?: string;
    /** Authenticated server-consumed review that approved this exact evidence
     * tuple before its ephemeral App was created. */
    designReviewReceipt?: FactoryHumanAuthorizationReceipt;
    designReviewSubjectDigest?: string;
    autopilotReview?: FactoryAutopilotSandboxReviewEvidence;
    /** Full-chain sandbox tool-dispatch proof. External handlers must never run
     * live; every external call is backed by an exact attempt cassette. */
    externalLiveCalls?: number | null;
    replayReceipts?: import("./ports").SandboxToolDispatchReceipt[];
    sandboxReplayEvidenceComplete?: boolean;
    /** Exact binding/config-scoped cassette references sealed into this
     * attempt's remote bundle. Never reconstruct these later from a display
     * catalog: global, tenant-native and multi-config uses would be lost. */
    cassetteRefs?: SandboxDeployResult["cassetteRefs"];
    ts: number;
  } | null;
  /** #P3 — 独立监督者的版本锁定缺陷(在 sandbox_run 后审计+结转,finish 门读它清零)。
   *  in-memory across turns within one runBrain;重启后重置(下一次 sandbox_run 重填,execution_fidelity
   *  仍从持久 lastSandbox.fidelityFailures 兜底,不 fail-open)。 */
  defects?: import("./supervisor").VersionLockedDefect[];
  /** #P3 — 沙箱运行序号(证据指纹变化时 +1),作版本锁定缺陷的"版本"信号:证据消失且此序号 > 缺陷
   *  的 foundAtVersion 才算复验关闭(防同一指纹重跑洗白)。 */
  sandboxSeq?: number;
  /** last validate_graph result with per-agent backref (refine reads agentIssueMap[slug]). */
  lastValidation: {
    agentIssueMap: Record<string, unknown[]>;
    ok: boolean;
  } | null;
  /** #BLUEPRINT — last build_blueprint result (ontology-grounded phased model + rendered SVGs).
   *  generate_report reads it to append a blueprint section to the HTML/PDF report. */
  lastBlueprint?: import("./blueprint").BlueprintModel;
  /** authoritative directives a human injected mid-run (HITL). */
  humanDirectives: string[];
  /** the intent gate's structured reading of the user's goal(s) — APPENDED per new goal so the
   *  conversation's intent history accumulates. Fold-surviving + serialized via serializeCtx. */
  userIntent?: string;
  /** capability_resolve 的决策表摘要（复用/组合/新造 per action，G1 能力解析门）——设计阶段
   *  持续引用「先选型再制造」的结论。Fold-surviving + serialized via serializeCtx. */
  capabilityResolution?: string;
  /** the brain's explicit, AI-synthesized understanding of the ontology (understand_ontology) —
   *  kept so the design phase reasons over a digested model, not a raw re-read ("读了就忘"). */
  ontologyUnderstanding?: string;
  /** ontology CONTENT hash captured when ontologyUnderstanding was computed — understand_ontology
   *  replays the remembered understanding while this matches the current ontology (cache gate),
   *  and re-digests automatically the moment the ontology actually changes. */
  ontologyUnderstandingSig?: string;
  /** #UNDERSTAND-FIDELITY — HOW the remembered understanding was produced. The content hash alone
   *  cannot distinguish a deterministic skeleton from a full four-dimension deep read, so a cheap
   *  early skeleton used to satisfy (and silently swallow) a later explicit `deep:true` request.
   *  The cache now only serves a request whose fidelity it actually meets. */
  ontologyUnderstandingMode?: "skeleton" | "shallow" | "deep";
  /** #FULL-DIMENSION — the provable per-dimension coverage behind a `deep` understanding, retained
   *  so a cache replay can restate it honestly instead of dropping the disclosure. */
  ontologyUnderstandingCoverage?: {
    itemsAnalyzed: number;
    itemsTotal: number;
    batches: number;
    oversized: number;
    complete: boolean;
  };
  /** #AMBIGUITY-COUNT — how many ambiguities understand_ontology actually found, recorded as DATA
   *  by the writer. The policy router previously recovered this by regex-scraping the understanding
   *  prose for "N 处歧义" — a literal no healthy writer ever emits (it lives in tool summaries), so
   *  the ask_first route was dead on success and fired only on the degraded fallback stitch, which
   *  concatenates specialist summaries that DO contain it. Never re-derive this from prose. */
  ontologyAmbiguityCount?: number;
  /** #PERSPECTIVES — which stakeholder lenses the deep read ran, with honest outcome.
   *  Presence = the deep understanding is lens-AWARE（#UNDERSTAND-CACHE 的保真版本号：镜头前的
   *  深读摘要不携带此字段，不得静默满足镜头时代的显式 deep:true）；absent = 镜头前产物或已关闭。
   *  视角的具体发现并入 ontologyUnderstanding 正文，这里只记选配与成败。Fold/serialize-surviving. */
  ontologyPerspectives?: {
    selected: Array<{
      id: string;
      label: string;
      focus: string;
      adapted: boolean;
    }>;
    okCount: number;
    total: number;
    source: "llm" | "fallback";
  };
  /** reflections loaded on start from prior runs of this domain. */
  priorReflections: ReflectionLite[];
  /** the conversation key (durability) + abort signal (client disconnect). */
  conversationId?: string;
  /** Durable Factory run attribution for tenant-routed model usage. */
  factoryRunId?: string;
  signal?: AbortSignal;
  /** #CONV-ARCHIVE — how many compaction folds have archived turns for this conversation.
   *  Persists via serializeCtx so archive batches stay attributable across restarts. */
  compactionFolds?: number;
  /** sub-brain recursion depth (0 = main brain) — bounds spawn_subagent fan-out (R9). */
  subagentDepth?: number;
  /** #TREE-BUDGET — the spend ledger shared by reference across the whole spawn tree (see BudgetLedger).
   *  Present on every ctx (root creates it; children inherit the same object). */
  budgetLedger?: BudgetLedger;
  /** #RUN-REGRESSION (P1-6) — per-case verdict snapshot from the last regression replay, so the next
   *  replay reports fixed/regressed per test case instead of a bare pass count. Fold/restart-surviving. */
  regressionBaseline?: {
    fingerprint: string;
    at: number;
    verdicts: Record<string, { pass: boolean; kind: string; reason: string }>;
  };
}

/** #TREE-BUDGET — a single spend ledger shared BY REFERENCE across the WHOLE spawn tree (root brain +
 *  every nested sub-brain / group member). Without it, a reasoning-driven parallel fan-out × recursion
 *  would each build an independent fresh budget (maxTurns=200 / MAX_TOKENS) and multiply into unbounded
 *  aggregate spend. Every LLM call adds to `tokens`; every spawn adds to `spawns`; the brainLoop enforces
 *  the tree-wide token ceiling and the spawn tools enforce `maxSpawns`. */
export interface BudgetLedger {
  tokens: number;
  spawns: number;
  maxTokens: number | null;
  maxSpawns: number;
}

// #TOOL-EFFECT (P0-2) — every brain tool declares what it DOES. Before this, `BrainTool` carried
// no effect metadata at all, so two independent consumers each kept their own hardcoded NAME LIST
// (side-effect-tools.ts's checkpoint set, conductor.ts's STAGE_OF_TOOL) and both failed OPEN for
// anything absent from the list. The information belongs on the tool, and the field is REQUIRED so
// an unannotated tool is a COMPILE error rather than a silent hole.
//
// Vocabulary is deliberately not a third dialect: `sideEffect` is the same closed set the runtime
// manifest uses for `tool_use[].side_effect` (packages/runtime/src/manifest.ts) and that
// `ToolCatalogEntry.sideEffect` uses (packages/tools/src/registry.ts).

/** What a successful call does from the caller's point of view. Same closed set as the runtime
 *  manifest's `tool_use[].side_effect`: read / write / dual (both) / call (an invocation whose
 *  remote effect is not classifiable as a plain read or write). */
export type BrainToolSideEffect = "read" | "write" | "dual" | "call";

/** WHERE a successful call lands, ordered by blast radius. Extends `ToolEffectScope`
 *  ("none" | "sandbox_local" | "external", packages/tools/src/registry.ts) with the two scopes a
 *  FACTORY tool has that a workflow tool does not — the brain's own conversation ctx, and the
 *  operator's durable factory assets — plus `production` for the promotion surface.
 *
 *  NOTE on LLM spend: burning provider tokens is NOT what makes a tool side-effecting. Token spend
 *  is bounded separately and tree-wide by BudgetLedger. Only a tool that calls a third party, or
 *  that spends on behalf of a FAN-OUT it owns (spawn_* / *_fleet), declares `external`. */
export type BrainToolEffectScope =
  /** pure computation, or a read of state already in ctx. */
  | "none"
  /** mutates the conversation/ctx only — already covered by the per-turn #CRASH-CKPT. */
  | "conversation"
  /** persists an operator-visible factory asset (draft / tool / skill / fixture / profile / report). */
  | "factory_durable"
  /** deploys into or executes inside the ephemeral factory sandbox (billed, disposable). */
  | "sandbox"
  /** reaches a third party, or spends provider budget on a fan-out this tool owns. */
  | "external"
  /** touches a promoted tenant runtime. NOTHING declares this today; it exists so the later
   *  risk-tier table can express "production → needs human sign-off" without a re-annotation. */
  | "production";

/** #W2-STAGE — the declared admission gate. A real `FactoryStage` means "subject to that stage's
 *  entry conditions"; `"any"` means the tool is legitimately stage-free (it is not part of the
 *  pipeline ORDER at all). `"any"` on anything beyond `scope:"conversation"` additionally requires
 *  `stageFreeReason` — see assertBrainToolGatesDeclared in side-effect-tools.ts. */
export type BrainToolGate = FactoryStage | "any";

/** #TOOL-EFFECT — TWO ORTHOGONAL AXES, because they genuinely disagree:
 *
 *  • (sideEffect, scope) = BLAST RADIUS. This is what a later risk-tier table reads
 *    ("read → straight through / write → rule check / production → human sign-off").
 *  • checkpoint = CRASH-RESUME DURABILITY (#SIDE-EFFECT-CKPT): must the completed call be made
 *    durable at once so boot auto-resume cannot re-issue it?
 *
 *  `understand_ontology` is the proof they are not one axis: it upserts a durable domain-insight pack
 *  (scope "factory_durable"), but the upsert is keyed by (domain, ontologySig) and its real product
 *  lands in ctx, so replaying it costs nothing → checkpoint "turn". Collapsing the two would either
 *  checkpoint every ctx builder or miss a real duplicate. */
export interface BrainToolEffect {
  sideEffect: BrainToolSideEffect;
  scope: BrainToolEffectScope;
  /** "immediate" ⇔ a replay would duplicate an effect that is expensive, externally visible, or
   *  creates a NEW durable row/artifact. A monotonic usage counter is none of those. */
  checkpoint: "turn" | "immediate";
  gate: BrainToolGate;
  /** true ⇔ entering this tool also moves the canvas stage rail to `gate` (STAGE_OF_TOOL is derived
   *  from this). Only legal together with a real stage gate. Auxiliary reads leave it false so the
   *  rail does not jump backward on an incidental lookup. */
  advancesStage?: boolean;
  /** REQUIRED when `gate === "any"` and the tool reaches past the conversation: WHY it is
   *  legitimately outside the pipeline order, and what gates the effect instead. Free text, but its
   *  presence is asserted at registration so a stage-free side effect is always a reviewed
   *  decision rather than an omission. */
  stageFreeReason?: string;
}

export interface BrainTool {
  name: string;
  description: string;
  /** JSON schema for the args. MUST include a `reasoning` string so the model
   *  articulates WHY before acting (some models emit no content before tool calls). */
  parameters: Record<string, unknown>;
  /** #TOOL-EFFECT — required: an unannotated tool must not compile (see BrainToolEffect). */
  effect: BrainToolEffect;
  execute(
    args: Record<string, unknown>,
    ctx: BrainCtx,
  ): Promise<BrainToolResult>;
}
