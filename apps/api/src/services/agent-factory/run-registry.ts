// In-process background-run registry — migrated from the OLD repo's
// lib/agent-factory-v3/brain/run-registry.ts.
//
// Decouples the autonomous brain from the SSE request lifecycle: the conductor runs
// in a DETACHED driver here, so navigating away (closing the EventSource) no longer
// aborts it — the run keeps going server-side and a later reconnect re-attaches to the
// live stream. A stop button aborts it explicitly. The transcript mirrors to
// factory_runs every few seconds, so a reconnect after eviction/restart replays from
// the durable row. Limitation (accepted): in-process, so an api restart ends in-flight
// runs (the durable row keeps `running` → the UI offers 继续 via the conversation checkpoint).

import {
  activeHumanInteraction,
  runBrain,
  runWithLlmCallContext,
  factoryGenerationDirectiveFingerprint,
  humanInteractionMatchesSubject,
  type BrainContinuationMode,
  type BrainEvent,
  type FactoryGenerationDirective,
  type FactoryInteractionPolicy,
} from "@agentic/agent-factory";
import { makeId } from "@agentic/shared";
import {
  and,
  businessOntologyDomains,
  eq,
  factoryConversations,
  factoryRuns,
  getDb,
  ontocodeBuildExecutions,
  tenants,
} from "@agentic/db";
import { inArray, isNull } from "drizzle-orm";
import {
  makeFactoryPorts,
  recordRunStart,
  recordRunFinish,
  recordRunProgress,
  getRun,
  markRunAborted,
  listRunningRuns,
} from "./index";
import { hasPendingHumanInteraction, pushHumanMessage } from "./mailbox";
import { getFactoryDomainBinding } from "./domain-binding";
import {
  appendFactoryRunTranscript,
  readFactoryRunTranscript,
} from "./factory-run-transcript";

export type RunStatus =
  | "running"
  | "waiting_human"
  | "done"
  | "error"
  | "aborted"
  | "failed";
type Frame = BrainEvent | { t: "run.started"; runId: string };
type Subscriber = (e: Frame) => void;

/** The caller may safely surface this as an input-delivery failure: the run
 * remains alive, but the requested continuation was not accepted. */
export class FactoryMessageDeliveryError extends Error {
  readonly code = "message_delivery_failed";
}

interface ActiveRun {
  runId: string;
  domain: string;
  goal: string;
  tenantSlug?: string; // scopes uploaded-ontology resolution to the run's tenant
  tenantId?: string;
  ontologyDomainRegistrationId?: string | null;
  runtimeProfileVersionId?: string | null;
  confirmedActor?: string;
  continuationMode?: BrainContinuationMode;
  interactionPolicy?: FactoryInteractionPolicy;
  generationDirective?: FactoryGenerationDirective;
  executionBudget?: {
    maxTurns?: number;
    maxToolCalls?: number;
    stableExecutionId?: string;
  };
  events: BrainEvent[];
  /** Events emitted since the last NDJSON flush — appended incrementally to the
   * durable sidecar (O(delta)) instead of re-serializing the whole buffer. */
  pendingNdjson: BrainEvent[];
  subscribers: Set<Subscriber>;
  status: RunStatus;
  abort: AbortController;
  tokensUsed: number;
  turns: number;
  agentsCount: number;
  reachedTerminal: boolean;
  errorMessage: string | null;
  sawDone: boolean;
  sawSandbox: boolean;
  evictTimer?: ReturnType<typeof setTimeout>;
}

const runsReg = new Map<string, ActiveRun>();
// Reconnect/resume window: how long a settled run stays in the in-memory registry before eviction.
const EVICT_AFTER_MS = Number(process.env.FACTORY_RUN_EVICT_MS) || 10 * 60_000;
// #5/#6: the persisted transcript the activity log + AI reviewer read. Raised + configurable so a
// long run's narrative (incl. the sandbox/done outcome) isn't lost; when exceeded we keep the most
// RECENT events (the outcome) rather than dropping new ones.
// #P0-6 — raised 30k→100k (configurable) so long factory runs keep far more of their reasoning before
// any fold; and on overflow we DON'T silently drop — we fold deterministically (a marker event records
// how many early events were compacted), so the audit trail shows the gap instead of vanishing.
const MAX_BUFFER = Number(process.env.FACTORY_RUN_BUFFER_MAX) || 100_000;

export function isActiveRun(runId: string): boolean {
  const r = runsReg.get(runId);
  return !!r && r.status === "running";
}
export function hasRun(runId: string): boolean {
  return runsReg.has(runId);
}

function bufferEvent(r: ActiveRun, e0: BrainEvent): BrainEvent {
  // #OBSERVABILITY — stamp a REAL server-side wall-clock ts on every event at the single emit choke
  // point, so the UI can render true per-phase / per-agent durations (Workflow-panel style) for BOTH
  // live AND replayed runs (client arrival time would cluster on reconnect). Idempotent: never
  // re-stamp an event that already carries ts. Cast: the strict BrainEvent union has no ts member; the
  // web side reads it as an optional field (BrainEvent = {t;[k]:unknown}).
  const e: BrainEvent =
    (e0 as { ts?: number }).ts != null
      ? e0
      : ({
          ...(e0 as Record<string, unknown>),
          ts: Date.now(),
        } as unknown as BrainEvent);
  // Keep the most recent MAX_BUFFER events (drop oldest if over) so the run OUTCOME — the tail:
  // sandbox result + done — is never lost on a very long run (the old `< MAX` guard dropped the
  // tail, hiding exactly what the reviewer needs).
  r.events.push(e);
  if (r.events.length > MAX_BUFFER) {
    // #P0-6 — deterministic fold: instead of silently dropping the oldest events, remove them but
    // leave a single marker so a reviewer sees "N early events were compacted" rather than a gap that
    // reads as if nothing happened. The fold is idempotent (a prior marker's count is rolled forward).
    const overflow = r.events.length - MAX_BUFFER;
    const dropped = r.events.splice(0, overflow);
    const priorFold = dropped.find(
      (d) =>
        (d as { t?: string }).t === "reflect" &&
        String((d as { kind?: string }).kind) === "buffer-fold",
    );
    const priorCount = priorFold
      ? Number((priorFold as { count?: number }).count ?? 0)
      : 0;
    r.events.unshift({
      t: "reflect",
      kind: "buffer-fold",
      lesson: `已折叠 ${priorCount + overflow} 条早期事件（超出 ${MAX_BUFFER} 缓冲上限）`,
      count: priorCount + overflow,
    }); // #W1-15 typed (count is on the reflect member now)
  }
  return e;
}

function notifyEvent(r: ActiveRun, e: BrainEvent): void {
  for (const cb of r.subscribers) {
    try {
      cb(e);
    } catch {
      /* a dead subscriber never blocks the run */
    }
  }
}

function emit(r: ActiveRun, e0: BrainEvent): void {
  const e = bufferEvent(r, e0);
  // Queue for the durable NDJSON sidecar (append-only, O(delta)). Buffered from
  // the ring's fold so even folded-out events reach the durable log.
  r.pendingNdjson.push(e);
  notifyEvent(r, e);
}

/** The small structural projection persisted into SQLite (`transcript_json`).
 * Streamed `think` deltas are ~95% of a run's events and are the write-
 * amplification (F-03/F-04); they live only in the NDJSON sidecar. Every other
 * (structural) frame — agent.created / plan / stage / sandbox / done / … — is
 * kept so evidence derivation and the AI reviewer stay whole (F-15). */
export function structuralProjection(events: BrainEvent[]): BrainEvent[] {
  return events.filter((e) => (e as { t?: string }).t !== "think");
}

/** Drain the pending tail into the durable NDJSON sidecar. Best-effort: a miss
 * leaves the events queued for the next flush and never fails the run. */
function flushNdjson(r: ActiveRun): void {
  if (r.pendingNdjson.length === 0) return;
  const batch = r.pendingNdjson;
  r.pendingNdjson = [];
  void appendFactoryRunTranscript(r.tenantId, r.runId, batch).catch(() => {
    // Re-queue at the front so nothing is dropped; the next tick retries.
    r.pendingNdjson = batch.concat(r.pendingNdjson);
  });
}

/** Subscribe: immediately REPLAY run.started + buffered events (late joiner sees the
 *  whole story), then stream live. Returns unsub, or null if the run isn't registered
 *  (caller falls back to the durable factory_runs transcript). */
export function subscribeRun(
  runId: string,
  cb: Subscriber,
  tenantId?: string,
): null | (() => void) {
  const r = runsReg.get(runId);
  if (!r || (tenantId && r.tenantId !== tenantId)) return null;
  cb({ t: "run.started", runId });
  for (const e of r.events) cb(e);
  if (r.status !== "running") return () => {};
  r.subscribers.add(cb);
  return () => {
    r.subscribers.delete(cb);
  };
}

/** Abort a run (the stop button) — signals the conductor, which breaks at the next
 *  turn boundary and runs its cleanup (sandbox teardown etc.). */
export function abortRun(runId: string, tenantId?: string): boolean {
  const r = runsReg.get(runId);
  if (!r || r.status !== "running" || (tenantId && r.tenantId !== tenantId))
    return false;
  r.status = "aborted";
  try {
    r.abort.abort();
  } catch {
    /* already aborted */
  }
  emit(r, {
    t: "message",
    text: "⏹ 已请求停止——大脑会在当前步骤后收尾，已生成的内容都保留。",
  });
  return true;
}

/** #USER-MESSAGE — surface a human utterance (HITL gate answer / injected note) on the LIVE run's
 * transcript. Returns false when no active run matches — the words still travel via the mailbox;
 * only the visual echo is skipped. */
export function emitUserMessage(
  runId: string,
  tenantId: string | undefined,
  text: string,
): boolean {
  const r = runsReg.get(runId);
  if (!r || r.status !== "running" || (tenantId && r.tenantId !== tenantId))
    return false;
  const said = text.trim();
  if (!said) return false;
  emit(r, { t: "user.message", text: said } as BrainEvent);
  return true;
}

/** Start (or return the already-active) background run. IDEMPOTENT: a second
 *  connection with the same runId attaches to the SAME run. The driver is detached. */
export function startRun(opts: {
  domain: string;
  goal: string;
  tenantId?: string;
  tenantSlug?: string;
  /** Immutable Business Domain → Ontology Domain registration. OntoCode
   * always supplies this; standalone legacy Factory runs may omit it. */
  ontologyDomainRegistrationId?: string | null;
  /** Exact immutable Runtime Profile version inherited from OntoCode. */
  runtimeProfileVersionId?: string | null;
  /** Authenticated API actor captured outside the model/tool argument surface. */
  confirmedActor?: string;
  conversationId?: string;
  runId?: string;
  /** Goal to PERSIST on the factory_runs row when it differs from the internal
   * recovery steer. Crash recovery keeps the original history label here. */
  persistGoal?: string;
  /** Trusted recovery reason propagated to the conductor. Ordinary API goals
   * never gain resume semantics from their text. */
  continuationMode?: BrainContinuationMode;
  interactionPolicy?: FactoryInteractionPolicy;
  generationDirective?: FactoryGenerationDirective;
  executionBudget?: {
    maxTurns?: number;
    maxToolCalls?: number;
    stableExecutionId?: string;
  };
}): ActiveRun {
  const runId = opts.runId ?? opts.conversationId ?? makeId("frn");
  const existing = runsReg.get(runId);
  // Only RE-ATTACH to a still-RUNNING run (a reconnect). If the run under this id is
  // FINISHED, this is a NEW turn in the same conversation — start a fresh run (it resumes
  // the conversation context via conversationId). Returning the finished run instead made
  // subscribeRun REPLAY its buffered answer and silently drop the new message — the
  // "re-greet / 0-turn / 0-token" bug. (runId == conversationId here by design.)
  if (existing && existing.status === "running") {
    if (opts.tenantId && existing.tenantId !== opts.tenantId) {
      throw new Error("run belongs to another tenant");
    }
    if (existing.domain !== opts.domain) {
      throw new Error("run belongs to another ontology domain");
    }
    if (
      (existing.ontologyDomainRegistrationId ?? null) !==
      (opts.ontologyDomainRegistrationId ?? null)
    ) {
      throw new Error("run belongs to another ontology domain registration");
    }
    if (
      (existing.runtimeProfileVersionId ?? null) !==
      (opts.runtimeProfileVersionId ?? null)
    ) {
      throw new Error("run belongs to another runtime profile version");
    }
    if (
      opts.generationDirective &&
      factoryGenerationDirectiveFingerprint(existing.generationDirective) !==
        factoryGenerationDirectiveFingerprint(opts.generationDirective)
    ) {
      throw new Error(
        "generation scope is immutable within a running Factory conversation",
      );
    }
    const requestedInteractionPolicy = opts.interactionPolicy ?? "strict";
    const existingInteractionPolicy = existing.interactionPolicy ?? "strict";
    if (requestedInteractionPolicy !== existingInteractionPolicy) {
      throw new Error(
        "interaction policy cannot change while a Factory run is active",
      );
    }
    if (
      opts.executionBudget &&
      JSON.stringify(existing.executionBudget ?? null) !==
        JSON.stringify(opts.executionBudget)
    ) {
      throw new Error(
        "execution budget cannot change while a Factory run is active",
      );
    }
    // #ALIVE-2 (deliver, don't drop) — re-attaching with a NEW user message used to silently
    // discard it: the composer's goal never reached the still-running brain (the「发送没反应」half
    // of the 无响应 incident). Route it into the conversation mailbox — the SAME channel /inject
    // uses — so the parked/looping brain picks it up as a human message on its next mailbox read.
    const g = opts.goal ?? "";
    if (g.trim() && !opts.continuationMode) {
      // Message delivery is part of the start/continue request's contract.  A
      // best-effort catch here acknowledged input that the live brain would
      // never receive, leaving the UI in a false "running" state.  Refuse the
      // request unless the tenant-scoped mailbox accepted the message.
      const delivered = pushHumanMessage(
        opts.conversationId ?? runId,
        g,
        opts.tenantId,
        opts.confirmedActor,
      );
      if (!delivered) {
        throw new FactoryMessageDeliveryError(
          `factory conversation ${opts.conversationId ?? runId} rejected the new message`,
        );
      }
      // #USER-MESSAGE — the human's words are transcript, not just mailbox cargo.
      emit(existing, { t: "user.message", text: g } as BrainEvent);
      emit(existing, {
        t: "message",
        text: "📨 新消息已转交给正在运行的大脑（下一步读取；如果当前正等交互卡，这条普通消息不会替代卡片回答）。",
      } as BrainEvent);
    }
    return existing;
  }
  // recordRunStart deliberately throws on a foreign/old-domain primary key;
  // do not create an in-memory driver unless durable ownership was established.
  recordRunStart(
    opts.domain,
    opts.persistGoal ?? opts.goal,
    opts.tenantId,
    runId,
    opts.ontologyDomainRegistrationId,
    opts.runtimeProfileVersionId,
  );
  const r: ActiveRun = {
    runId,
    domain: opts.domain,
    goal: opts.goal,
    tenantSlug: opts.tenantSlug,
    tenantId: opts.tenantId,
    ontologyDomainRegistrationId: opts.ontologyDomainRegistrationId ?? null,
    runtimeProfileVersionId: opts.runtimeProfileVersionId ?? null,
    confirmedActor: opts.confirmedActor,
    continuationMode: opts.continuationMode,
    // Keep an omitted policy omitted until the conductor has loaded the
    // conversation checkpoint. Fresh conversations still resolve to `strict`
    // there, while a human-gate/crash resume must inherit the saved policy
    // instead of accidentally requesting a change from `autopilot` to `strict`.
    interactionPolicy: opts.interactionPolicy,
    generationDirective: opts.generationDirective,
    executionBudget: opts.executionBudget,
    events: [],
    pendingNdjson: [],
    subscribers: new Set(),
    status: "running",
    abort: new AbortController(),
    tokensUsed: 0,
    turns: 0,
    agentsCount: 0,
    reachedTerminal: false,
    errorMessage: null,
    sawDone: false,
    sawSandbox: false,
  };
  runsReg.set(runId, r);
  // #USER-MESSAGE — open the transcript with what the human actually asked (persistGoal keeps the
  // user's original words when the internal goal is a recovery steer). Control-plane resumes
  // (crash/human-gate) are NOT a new human utterance — the gate answer arrives via inject instead.
  if (!opts.continuationMode) {
    const said = (opts.persistGoal ?? opts.goal).trim();
    if (said) emit(r, { t: "user.message", text: said } as BrainEvent);
  }
  if (opts.generationDirective) {
    const directive = opts.generationDirective;
    emit(r, {
      t: "source.scope",
      schema: "agent-factory-source-scope/v1",
      domain: opts.domain,
      mode: directive.mode,
      actionIds: [...directive.requestedActionIds],
      actionNames: [...directive.requestedActionNames],
      actions: directive.requestedActions.map((action) => ({ ...action })),
      sourceOntologyHash: directive.sourceOntologyHash,
      ...(directive.scenario ? { scenario: directive.scenario } : {}),
    });
    if (directive.virtualAction) {
      emit(r, {
        t: "virtual_action.created",
        schema: "agent-factory-virtual-action/v1",
        actionId: directive.virtualAction.id,
        name: directive.virtualAction.name,
        trigger: [...directive.virtualAction.trigger],
        emit: [...directive.virtualAction.triggered_event],
        scenario: directive.scenario ?? "",
        provenance: directive.virtualAction.factoryProvenance,
      });
    }
    // Scope provenance is control-plane evidence, not transient narration.
    // Persist the structural frames before handing control to the asynchronous
    // brain so an immediate crash/reconnect still sees the exact source.
    recordRunProgress(
      r.runId,
      {
        transcript: structuralProjection(r.events),
        tokensUsed: 0,
        turns: 0,
        agentsCount: 0,
        reachedTerminal: false,
      },
      r.tenantId,
    );
    flushNdjson(r);
  }
  void drive(r, opts.conversationId ?? runId);
  return r;
}

/** #P0-3 — own this run's LLM attribution scope for its entire detached lifetime.
 *  The registry is where the authenticated tenant already lives, and the worker
 *  runs several brains in one process: an AsyncLocalStorage scope per driver is
 *  what makes two concurrent runs structurally unable to bill each other. The
 *  tenant is passed through as-is — a run started without one stays unattributed
 *  (the central gateway then refuses the call) instead of being assigned a guess. */
function drive(r: ActiveRun, conversationId: string): Promise<void> {
  return runWithLlmCallContext(
    {
      tenantId: r.tenantId,
      tenantSlug: r.tenantSlug,
      // factory_runs.id — deliberately NOT `runId`, the canonical `runs`
      // namespace both accounting tables have a foreign key to.
      factoryRunId: r.runId,
      conversationId,
      domain: r.domain,
    },
    () => driveScoped(r, conversationId),
  );
}

async function driveScoped(
  r: ActiveRun,
  conversationId: string,
): Promise<void> {
  const seenAgents = new Set<string>();
  let durablyFinalized = false;
  let pendingTerminal: BrainEvent | null = null;
  const persistTerminal = (terminal: BrainEvent): void => {
    // Terminal frame is already buffered + queued; flush the full stream to the
    // durable NDJSON sidecar, then finalize the row with the small structural
    // projection (evidence derivation reads this; full replay reads the sidecar).
    flushNdjson(r);
    recordRunFinish(
      r.runId,
      {
        status: r.status === "running" ? "done" : r.status,
        tokensUsed: r.tokensUsed,
        turns: r.turns,
        agentsCount: r.agentsCount,
        reachedTerminal: r.reachedTerminal,
        errorMessage: r.errorMessage ?? undefined,
        transcript: structuralProjection(r.events),
      },
      r.tenantId,
    );
    durablyFinalized = true;
    notifyEvent(r, terminal);
  };
  // #AUDIT-FIX(M21) — transcript 周期镜像（每 5s，.unref 不挡退出）：崩溃时 factory_runs 行
  // 不再只有上一次交互的旧转录（"实时镜像"的注释承诺此前是假的）。
  const mirror = setInterval(() => {
    try {
      if (r.status === "running") {
        // O(delta) durable append + a SMALL structural-projection row (no think
        // deltas). Replaces the old full-buffer re-serialize every 5s (F-03).
        flushNdjson(r);
        recordRunProgress(
          r.runId,
          {
            transcript: structuralProjection(r.events),
            tokensUsed: r.tokensUsed,
            turns: r.turns,
            agentsCount: r.agentsCount,
            reachedTerminal: r.reachedTerminal,
          },
          r.tenantId,
        );
      }
    } catch {
      /* mirror is best-effort */
    }
  }, 5000);
  (mirror as unknown as { unref?: () => void }).unref?.();
  try {
    const ports = makeFactoryPorts(
      r.tenantSlug,
      r.tenantId,
      r.domain,
      r.confirmedActor,
      r.ontologyDomainRegistrationId,
      r.runtimeProfileVersionId,
    );
    for await (const ev of runBrain({
      domain: r.domain,
      goal: r.goal,
      ports,
      runId: r.runId,
      signal: r.abort.signal,
      conversationId,
      authenticatedActor: r.confirmedActor,
      continuationMode: r.continuationMode,
      interactionPolicy: r.interactionPolicy,
      generationDirective: r.generationDirective,
      executionBudget: r.executionBudget,
    })) {
      if (ev.t === "agent.created")
        seenAgents.add((ev.spec as { slug: string }).slug);
      else if (ev.t === "sandbox") {
        r.sawSandbox = true;
        r.reachedTerminal = ev.fullChainRan ?? false;
      } else if (ev.t === "budget") {
        r.tokensUsed = Math.max(r.tokensUsed, ev.tokens);
        r.turns = Math.max(r.turns, ev.turn);
      } else if (ev.t === "done") {
        r.sawDone = true;
        r.turns = ev.turns;
        r.tokensUsed = ev.tokensUsed;
        // Honest terminal status: only an acceptance-gated delivery or a
        // conductor-declared informational answer succeeds. Never infer Q&A
        // from zero *new* agent events: a resumed generation may already have
        // specs in its durable conversation, and budget exhaustion is failure.
        if (r.status === "running") {
          if (ev.status === "waiting_human") r.status = "waiting_human";
          else if (ev.status === "errored") r.status = "error";
          else if (ev.status === "finished") r.status = "done";
          else if (ev.status === "incomplete" && ev.completionKind === "answer")
            r.status = "done";
          else r.status = "failed";
        }
        r.agentsCount = seenAgents.size;
        // A terminal SSE frame is a completion claim. Buffer it, durably
        // finalize the factory_runs row, and only then notify subscribers.
        // recordRunFinish is synchronous, so no reconnect can interleave with
        // this small buffer→commit→publish critical section.
        pendingTerminal = bufferEvent(r, ev);
        persistTerminal(pendingTerminal);
        pendingTerminal = null;
        break;
      } else if (ev.t === "error") {
        if (r.status === "running") r.status = "error";
        r.errorMessage = ev.message;
      }
      r.agentsCount = seenAgents.size;
      emit(r, ev);
      if (ev.t === "budget") {
        // Usage monitoring is a safety contract: if this exact counter cannot
        // be durably written, stop instead of continuing untracked spend. The
        // write is now a SMALL structural-projection row (no think deltas), so
        // the fail-closed path no longer re-serializes a multi-MB blob (F-04).
        flushNdjson(r);
        recordRunProgress(
          r.runId,
          {
            transcript: structuralProjection(r.events),
            tokensUsed: r.tokensUsed,
            turns: r.turns,
            agentsCount: r.agentsCount,
            reachedTerminal: r.reachedTerminal,
          },
          r.tenantId,
        );
      }
    }
    if (!durablyFinalized && r.status === "running") {
      r.status = "failed";
      r.errorMessage = "factory driver ended without a terminal done event";
    }
  } catch (e) {
    // A failed terminal commit must not leave its uncommitted `done` inside
    // the replay buffer. The finally block will attempt one truthful errored
    // terminal commit; subscribers never saw the failed completion claim.
    if (
      pendingTerminal &&
      !durablyFinalized &&
      r.events.at(-1) === pendingTerminal
    ) {
      r.events.pop();
      pendingTerminal = null;
      r.sawDone = false;
    }
    if (r.status === "running")
      r.status = r.abort.signal.aborted ? "aborted" : "error";
    else if (r.status !== "aborted") r.status = "error";
    r.errorMessage = (e as Error).message;
    if (!r.abort.signal.aborted)
      emit(r, { t: "error", message: (e as Error).message });
  } finally {
    clearInterval(mirror); // #AUDIT-FIX(M21)
    // Guarantee a terminal `done` so any subscriber unblocks even on
    // abort/crash, but publish it only after its durable verdict exists.
    if (!durablyFinalized) {
      pendingTerminal = bufferEvent(r, {
        t: "done",
        tokensUsed: r.tokensUsed,
        turns: r.turns,
        status:
          r.status === "waiting_human"
            ? "waiting_human"
            : r.status === "aborted"
              ? "incomplete"
              : r.status === "error" || r.status === "failed"
                ? "errored"
                : "incomplete",
        completionKind: "incomplete",
      });
      persistTerminal(pendingTerminal);
      pendingTerminal = null;
    }
    if (r.evictTimer) clearTimeout(r.evictTimer);
    r.evictTimer = setTimeout(() => {
      if (runsReg.get(r.runId) === r) runsReg.delete(r.runId);
    }, EVICT_AFTER_MS);
  }
}

/** Replay a finalized/orphaned run from the durable factory_runs row (reconnect after
 *  eviction or restart). Returns the saved transcript so the client replays. `deleted` lets
 *  the reconnect path show a tombstone instead of silently replaying a soft-deleted run. */
export async function readDurableRun(
  runId: string,
  tenantId?: string,
): Promise<{
  status: string;
  transcript: BrainEvent[];
  deleted: boolean;
} | null> {
  const row = getRun(runId, tenantId);
  if (!row) return null;
  // Prefer the append-only NDJSON sidecar (the FULL stream, incl. think deltas,
  // with no folded-away structural frames) for a faithful reconnect replay; fall
  // back to the SQLite structural projection for runs persisted before the
  // sidecar existed, or if the file is unavailable.
  const durable = await readFactoryRunTranscript(tenantId, runId);
  const transcript = durable.length
    ? durable
    : ((row.transcript as BrainEvent[]) ?? []);
  return { status: row.status, transcript, deleted: !!row.deletedAt };
}

const ORPHAN_REASON = "运行中断（服务器重启/进程丢失，无活跃驱动）";

/** /stop fallback: when abortRun finds no live driver, close the durable
 * unfinished row. This covers both an orphaned `running` row after restart and
 * a deliberately parked `waiting_human` run whose operator chose to stop.
 * Returns true iff an unfinished row was changed. */
export function forceFinalizeAborted(
  runId: string,
  tenantId?: string,
): boolean {
  if (!runId) return false;
  return markRunAborted(runId, ORPHAN_REASON, tenantId);
}

/** Zombie sweep: durable rows still 'running' but with NO live driver (isActiveRun) and
 *  past a short grace window → mark aborted. A genuinely-live run is in the registry and
 *  is therefore never swept. Called before listing runs so stuck "运行中" history rows
 *  auto-clear. Returns how many were swept. */
export function sweepZombieRuns(
  domain: string | null,
  tenantId?: string,
): number {
  const now = Date.now();
  let swept = 0;
  for (const row of listRunningRuns(domain, tenantId)) {
    if (!isActiveRun(row.id) && now - row.createdAt > 120_000) {
      if (markRunAborted(row.id, ORPHAN_REASON, tenantId)) swept++;
    }
  }
  return swept;
}

// #SCALE-RESUME — crash-safety without moving the brain onto Inngest: on api boot, every factory_runs
// row stuck "running" (the process died mid-run) is AUTO-RESUMED via its conversation checkpoint —
// serializeCtx persisted the full ctx (specs/plan/parked HITL gates included), so the brain picks up
// where it crashed instead of leaving a zombie for the user to manually 继续. Opt out: FACTORY_AUTORESUME=0.
export class AutoResumeRecoveryError extends Error {
  readonly failures: ReadonlyArray<{ runId: string; message: string }>;

  constructor(failures: ReadonlyArray<{ runId: string; message: string }>) {
    super(
      `Factory crash recovery failed for ${failures.length} run(s): ${failures
        .map((failure) => `${failure.runId}: ${failure.message}`)
        .join("; ")}`,
    );
    this.name = "AutoResumeRecoveryError";
    this.failures = failures;
  }
}

type ParkedCheckpointRecovery =
  | "settled"
  | "not_parked"
  | "no_longer_running"
  | "checkpoint_missing"
  | "checkpoint_invalid";

function recordValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** A crash can land after the conductor has durably opened a human gate but
 * before its terminal `waiting_human` verdict reaches factory_runs. Restarting
 * the model in that state duplicates work and can overwrite the exact prompt.
 * Reconcile only a tenant/domain-exact, prompt-addressed checkpoint, in the
 * same transaction that moves the orphan row out of `running`. */
function settleParkedClarificationCheckpoint(input: {
  runId: string;
  tenantId: string;
  domain: string;
}): ParkedCheckpointRecovery {
  return getDb().transaction((tx) => {
    const run = tx
      .select({
        status: factoryRuns.status,
        deletedAt: factoryRuns.deletedAt,
      })
      .from(factoryRuns)
      .where(
        and(
          eq(factoryRuns.id, input.runId),
          eq(factoryRuns.tenantId, input.tenantId),
        ),
      )
      .get();
    if (!run || run.status !== "running" || run.deletedAt !== null) {
      return "no_longer_running";
    }

    const conversation = tx
      .select({
        tenantId: factoryConversations.tenantId,
        domain: factoryConversations.domain,
        ctxJson: factoryConversations.ctxJson,
      })
      .from(factoryConversations)
      .where(eq(factoryConversations.id, input.runId))
      .get();
    if (!conversation) return "checkpoint_missing";
    const ctx = recordValue(conversation.ctxJson);
    if (
      conversation.tenantId !== input.tenantId ||
      conversation.domain !== input.domain ||
      !ctx
    ) {
      return "checkpoint_invalid";
    }

    const prompt = recordValue(ctx?.clarifyPrompt);
    const question =
      typeof prompt?.question === "string" ? prompt.question : null;
    const context =
      prompt?.context === undefined
        ? null
        : typeof prompt.context === "string"
          ? prompt.context
          : undefined;
    const options =
      prompt?.options === undefined
        ? null
        : Array.isArray(prompt.options) &&
            prompt.options.every((value) => {
              const option = recordValue(value);
              return (
                typeof option?.label === "string" &&
                option.label.trim().length > 0 &&
                typeof option.value === "string" &&
                option.value.trim().length > 0 &&
                (option.recommended === undefined ||
                  typeof option.recommended === "boolean")
              );
            })
          ? prompt.options
          : undefined;
    const interaction = ctx
      ? activeHumanInteraction(
          ctx as Parameters<typeof activeHumanInteraction>[0],
        )
      : null;
    const validInteraction =
      interaction?.kind === "clarify" &&
      typeof interaction.interactionId === "string" &&
      interaction.interactionId.trim().length > 0 &&
      typeof interaction.subjectDigest === "string" &&
      /^[a-f0-9]{64}$/i.test(interaction.subjectDigest) &&
      Number.isSafeInteger(interaction.createdAt) &&
      interaction.createdAt > 0;
    if (
      ctx.awaitingClarify !== true ||
      !question?.trim() ||
      context === undefined ||
      options === undefined ||
      !interaction ||
      !validInteraction ||
      !humanInteractionMatchesSubject(interaction, "clarify", {
        question,
        context,
        options,
      })
    ) {
      return "not_parked";
    }

    // An answer for this exact durable gate is work to resume, not proof that
    // the user still needs to be asked. Parking here strands its at-least-once
    // delivery forever. Generic chat and answers for another gate deliberately
    // do not count: neither is authorized to resolve this interaction.
    if (
      hasPendingHumanInteraction(
        input.runId,
        interaction.interactionId,
        interaction.kind,
        input.tenantId,
      )
    ) {
      return "not_parked";
    }

    const updated = tx
      .update(factoryRuns)
      .set({
        status: "waiting_human",
        reachedTerminal: false,
        errorMessage: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(factoryRuns.id, input.runId),
          eq(factoryRuns.tenantId, input.tenantId),
          eq(factoryRuns.status, "running"),
          isNull(factoryRuns.deletedAt),
        ),
      )
      .run() as { changes?: number };
    if ((updated.changes ?? 0) !== 1) {
      throw new Error(
        "parked checkpoint row changed before it could be reconciled",
      );
    }
    return "settled";
  });
}

export function autoResumeCrashedRuns(): number {
  if (process.env.FACTORY_AUTORESUME === "0") return 0;
  let resumed = 0;
  let parked = 0;
  const failures: Array<{ runId: string; message: string }> = [];
  // #AUDIT-FIX(H8) — join tenants 取回 slug：无 slug 恢复的 run 拿到未限定 ports（上传本体层
  // 为空、report/fleet 缺失），行为与原 run 静默不同。 The query is deliberately allowed to
  // throw: a broken recovery store must prevent the API from reporting startup success.
  const rows = getDb()
    .select({
      id: factoryRuns.id,
      domain: factoryRuns.domain,
      goal: factoryRuns.goal,
      tenantId: factoryRuns.tenantId,
      tenantSlug: tenants.slug,
      ontologyDomainRegistrationId: factoryRuns.ontologyDomainRegistrationId,
      runtimeProfileVersionId: factoryRuns.runtimeProfileVersionId,
      createdAt: factoryRuns.createdAt,
    })
    .from(factoryRuns)
    .leftJoin(tenants, eq(tenants.id, factoryRuns.tenantId))
    .where(
      and(eq(factoryRuns.status, "running"), isNull(factoryRuns.deletedAt)),
    )
    .all();
  // #AUDIT-FIX(M23) — 年龄上限 + 单次启动恢复数上限：老僵尸行标记 aborted 而不是无限重跑；
  // 一次 boot 最多恢复 3 个（其余标记，防止重启风暴挤爆进程）。
  const MAX_AGE_MS = Math.max(
    3600_000,
    Number(process.env.FACTORY_AUTORESUME_MAX_AGE_MS) || 24 * 3600_000,
  );
  const MAX_RESUME = Math.max(
    1,
    Number(process.env.FACTORY_AUTORESUME_MAX) || 3,
  );
  const finalizeInterrupted = (
    runId: string,
    reason: string,
    tenantId?: string,
  ): void => {
    try {
      if (!markRunAborted(runId, reason, tenantId)) {
        throw new Error(
          "durable row was not transitioned from running to aborted",
        );
      }
    } catch (err) {
      failures.push({
        runId,
        message: String(
          (err as { message?: unknown } | null)?.message ?? err,
        ).slice(0, 240),
      });
    }
  };
  for (const r of rows) {
    if (isActiveRun(r.id)) continue; // already live in this process
    // OntoCode owns recovery for every nonterminal stable Build. Its Harness
    // lease + answer envelope must be reconciled before the private engine is
    // resumed; the generic Factory boot path has neither and could otherwise
    // start the same conversation without the public continuation answer.
    const ontocodeOwner = getDb()
      .select({ id: ontocodeBuildExecutions.id })
      .from(ontocodeBuildExecutions)
      .where(
        and(
          eq(ontocodeBuildExecutions.tenantId, r.tenantId),
          eq(ontocodeBuildExecutions.engineKind, "agent_factory"),
          eq(ontocodeBuildExecutions.engineRunId, r.id),
          inArray(ontocodeBuildExecutions.state, [
            "new",
            "running",
            "resuming",
            "waiting_user",
            "generated_unverified",
            "failed_recoverable",
          ]),
        ),
      )
      .get();
    if (ontocodeOwner) continue;
    let parkedRecovery: ParkedCheckpointRecovery;
    try {
      parkedRecovery = settleParkedClarificationCheckpoint({
        runId: r.id,
        tenantId: r.tenantId,
        domain: r.domain,
      });
    } catch (err) {
      failures.push({
        runId: r.id,
        message: String(
          (err as { message?: unknown } | null)?.message ?? err,
        ).slice(0, 240),
      });
      continue;
    }
    if (parkedRecovery === "settled") {
      parked += 1;
      continue;
    }
    if (parkedRecovery === "no_longer_running") continue;
    if (
      parkedRecovery === "checkpoint_missing" ||
      parkedRecovery === "checkpoint_invalid"
    ) {
      // `crash_resume` without a conversation checkpoint starts a brand-new
      // brain under an internal recovery sentence, losing the original scope,
      // policy and budget. Close that orphan instead; the owning Harness Job
      // can then retry from its immutable command and Ontology snapshot.
      finalizeInterrupted(
        r.id,
        parkedRecovery === "checkpoint_missing"
          ? "进程恢复被拒绝：没有可恢复的 Factory conversation checkpoint；由上层 Harness 从原始命令重新执行。"
          : "进程恢复被拒绝：Factory conversation checkpoint 的租户、领域或结构无效；由上层 Harness 决定是否重新执行。",
        r.tenantId ?? undefined,
      );
      continue;
    }
    const registration = r.ontologyDomainRegistrationId
      ? getDb()
          .select({
            tenantId: businessOntologyDomains.tenantId,
            ontologyDomainId: businessOntologyDomains.ontologyDomainId,
            status: businessOntologyDomains.status,
            archivedAt: businessOntologyDomains.archivedAt,
          })
          .from(businessOntologyDomains)
          .where(
            and(
              eq(businessOntologyDomains.id, r.ontologyDomainRegistrationId),
              eq(businessOntologyDomains.tenantId, r.tenantId),
            ),
          )
          .all()[0]
      : null;
    const binding = r.ontologyDomainRegistrationId
      ? null
      : getFactoryDomainBinding(r.tenantId);
    const registrationValid = r.ontologyDomainRegistrationId
      ? registration?.ontologyDomainId === r.domain &&
        registration.status === "active" &&
        registration.archivedAt === null
      : Boolean(binding && binding.ontologyDomainId === r.domain);
    if (!registrationValid) {
      finalizeInterrupted(
        r.id,
        r.ontologyDomainRegistrationId
          ? `进程恢复被拒绝：Ontology Domain 注册「${r.ontologyDomainRegistrationId}」已失效或与中断运行的本体「${r.domain}」不一致。`
          : `进程恢复被拒绝：当前业务领域${binding ? `已连接「${binding.ontologyDomainId}」` : "尚未连接本体"}，与中断运行的本体「${r.domain}」不一致。`,
        r.tenantId ?? undefined,
      );
      continue;
    }
    const age =
      Date.now() -
      new Date(r.createdAt as unknown as string | number | Date).getTime();
    if (Number.isFinite(age) && age > MAX_AGE_MS) {
      finalizeInterrupted(
        r.id,
        `中断超过 ${Math.round(MAX_AGE_MS / 3600_000)}h 未恢复——按放弃处理（可从历史运行重新发起）`,
        r.tenantId ?? undefined,
      );
      continue;
    }
    if (resumed >= MAX_RESUME) {
      finalizeInterrupted(
        r.id,
        "本次启动恢复名额已满——按中断处理（可从历史运行重新发起）",
        r.tenantId ?? undefined,
      );
      continue;
    }
    try {
      startRun({
        domain: r.domain,
        goal: "进程重启后自动续跑：从状态摘要与最近上下文接续先前任务，不要重复已完成的步骤。",
        continuationMode: "crash_resume",
        persistGoal: (r.goal as string | null) ?? undefined,
        tenantId: r.tenantId ?? undefined,
        tenantSlug:
          (r as { tenantSlug?: string | null }).tenantSlug ?? undefined,
        ontologyDomainRegistrationId: r.ontologyDomainRegistrationId ?? null,
        runtimeProfileVersionId: r.runtimeProfileVersionId ?? null,
        conversationId: r.id,
        runId: r.id,
      });
      resumed += 1;
    } catch (err) {
      failures.push({
        runId: r.id,
        message: String(
          (err as { message?: unknown } | null)?.message ?? err,
        ).slice(0, 240),
      });
    }
  }
  if (resumed)
    console.log(
      `[factory] crash-resume — re-attached ${resumed} interrupted run(s) from their conversation checkpoints`,
    );
  if (parked)
    console.log(
      `[factory] crash-recovery — restored ${parked} parked human gate(s) without restarting the model`,
    );
  if (failures.length > 0) throw new AutoResumeRecoveryError(failures);
  return resumed;
}
