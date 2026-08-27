/**
 * Folds a flat `GET /v1/runs/:id/trace` event list into the shape the monitor
 * timeline renders: step → attempt → turn → tool call.
 *
 * The nesting is NOT in `parentId`. That column exists on `run_trace_events`
 * but no producer ever sets it — it is null on every row — so the hierarchy has
 * to be recovered from three signals that ARE populated:
 *
 *   - a `kind:"step"` row with `status:"running"` OPENS an attempt. Inngest
 *     retries a failed step body in place under the same `stepId`, so the same
 *     step appears as running → failed → running → ok, and the second `running`
 *     is attempt 2 rather than a duplicate.
 *   - `data.iteration` groups rows into agent turns within an attempt. Every
 *     `kind:"llm"` and `kind:"tool"` row carries it, and it restarts at 1 for
 *     each attempt.
 *   - `data.callIndex` identifies a tool call within an attempt, which is how a
 *     `<name>.evidence` row is joined back to the call it describes. Evidence
 *     rows carry `callIndex` but NOT `iteration`, so they cannot be grouped by
 *     turn directly.
 *
 * Everything degrades rather than throws: a run whose rows predate any of these
 * fields folds to a single flat attempt with `degraded: true`, and the panel
 * renders the flat list instead of a tree.
 */

/** One row as returned by GET /v1/runs/:id/trace. */
export interface RunTraceEvent {
  id: string;
  runId: string;
  stepId: string | null;
  parentId: string | null;
  seq: number;
  kind: "run" | "step" | "llm" | "tool" | "artifact" | string;
  level: string;
  name: string;
  status: string | null;
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number | null;
  summary: string | null;
  data: Record<string, unknown> | null;
  artifactId: string | null;
  visibility: "user" | "operator" | "debug" | string;
  createdAt: string;
}

export interface ToolCallNode {
  seq: number;
  /** Tool name with any `.evidence` suffix stripped. */
  tool: string;
  callIndex: number | null;
  status: string | null;
  isError: boolean;
  durationMs: number | null;
  summary: string | null;
  /** Artifact holding the call's input/output, from the `.evidence` row. */
  evidenceArtifactId: string | null;
  resolvedVia: string | null;
}

export interface TurnNode {
  iteration: number;
  provider: string | null;
  model: string | null;
  tokensIn: number | null;
  tokensOut: number | null;
  durationMs: number | null;
  finishReason: string | null;
  /** Artifact holding the turn's reasoning/response, from an `llm.turn.N` row. */
  artifactId: string | null;
  toolCalls: ToolCallNode[];
}

export interface AttemptNode {
  attempt: number;
  status: string | null;
  startedAt: string | null;
  durationMs: number | null;
  summary: string | null;
  error: string | null;
  turns: TurnNode[];
  /** Tool calls that carried no iteration — shown flat under the attempt. */
  looseToolCalls: ToolCallNode[];
  tokensIn: number;
  tokensOut: number;
}

export interface StepNode {
  stepId: string;
  name: string;
  type: string | null;
  visibility: string;
  attempts: AttemptNode[];
}

export interface RunTraceTree {
  /** `kind:"run"` rows, in order — the run's own lifecycle. */
  runLevel: RunTraceEvent[];
  steps: StepNode[];
  /** True when nesting signals were missing and the fold fell back to flat. */
  degraded: boolean;
  totals: { tokensIn: number; tokensOut: number; toolCalls: number };
}

const EVIDENCE_SUFFIX = ".evidence";

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/** `llm.turn.7` → 7; anything else → null. */
function turnRowIteration(name: string): number | null {
  const m = /^llm\.turn\.(\d+)$/.exec(name);
  return m ? Number(m[1]) : null;
}

function emptyAttempt(attempt: number, row: RunTraceEvent): AttemptNode {
  return {
    attempt,
    status: row.status,
    startedAt: row.startedAt,
    durationMs: row.durationMs,
    summary: row.summary,
    error: str(row.data?.error),
    turns: [],
    looseToolCalls: [],
    tokensIn: 0,
    tokensOut: 0,
  };
}

function turnFor(attempt: AttemptNode, iteration: number): TurnNode {
  let turn = attempt.turns.find((t) => t.iteration === iteration);
  if (!turn) {
    turn = {
      iteration,
      provider: null,
      model: null,
      tokensIn: null,
      tokensOut: null,
      durationMs: null,
      finishReason: null,
      artifactId: null,
      toolCalls: [],
    };
    attempt.turns.push(turn);
  }
  return turn;
}

export function buildRunTraceTree(events: RunTraceEvent[]): RunTraceTree {
  const ordered = [...events].sort((a, b) => a.seq - b.seq);

  const runLevel: RunTraceEvent[] = [];
  const steps: StepNode[] = [];
  const stepById = new Map<string, StepNode>();
  // The attempt currently accepting rows, per step.
  const openAttempt = new Map<string, AttemptNode>();
  let lastStepId: string | null = null;
  let sawIteration = false;
  let sawTool = false;

  // Evidence rows are joined to their call by (stepId, attempt, callIndex).
  const pendingEvidence = new Map<string, RunTraceEvent[]>();
  const evidenceKey = (stepId: string, attempt: number, callIndex: number) =>
    `${stepId}#${attempt}#${callIndex}`;

  for (const row of ordered) {
    if (row.kind === "run") {
      runLevel.push(row);
      continue;
    }

    const stepId: string | null = row.stepId ?? lastStepId;
    if (!stepId) continue;

    if (row.kind === "step") {
      lastStepId = stepId;
      let step = stepById.get(stepId);
      if (!step) {
        step = {
          stepId,
          name: row.name,
          type: str(row.data?.type),
          visibility: row.visibility,
          attempts: [],
        };
        stepById.set(stepId, step);
        steps.push(step);
      } else if (step.name === stepId) {
        // Replace the placeholder name minted above by a non-step row.
        step.name = row.name;
      }
      step.type ??= str(row.data?.type);

      if (row.status === "running") {
        // Opens a new attempt — Inngest retries in place under the same stepId.
        const attempt = emptyAttempt(step.attempts.length + 1, row);
        step.attempts.push(attempt);
        openAttempt.set(stepId, attempt);
      } else {
        // Terminal row for the attempt currently open (or a lone terminal row
        // on a trace whose opening row was trimmed by the `after` cursor).
        let attempt = openAttempt.get(stepId);
        if (!attempt) {
          attempt = emptyAttempt(step.attempts.length + 1, row);
          step.attempts.push(attempt);
          openAttempt.set(stepId, attempt);
        }
        attempt.status = row.status;
        attempt.durationMs = row.durationMs ?? attempt.durationMs;
        attempt.summary = attempt.summary ?? row.summary;
        attempt.error = str(row.data?.error) ?? attempt.error;
        const ti = num(row.data?.tokensIn);
        const to = num(row.data?.tokensOut);
        if (ti !== null) attempt.tokensIn = Math.max(attempt.tokensIn, ti);
        if (to !== null) attempt.tokensOut = Math.max(attempt.tokensOut, to);
      }
      continue;
    }

    lastStepId = stepId;
    // A trace trimmed by the `after` cursor can deliver llm/tool rows whose
    // opening step row is already behind the cursor. Materialise the step from
    // what the row knows rather than dropping the work it describes; a later
    // step row fills in the real name and type.
    let step = stepById.get(stepId);
    if (!step) {
      step = {
        stepId,
        name: stepId,
        type: null,
        visibility: row.visibility,
        attempts: [],
      };
      stepById.set(stepId, step);
      steps.push(step);
    }
    let attempt = openAttempt.get(stepId);
    if (!attempt) {
      attempt = emptyAttempt(step.attempts.length + 1, row);
      step.attempts.push(attempt);
      openAttempt.set(stepId, attempt);
    }

    if (row.kind === "llm") {
      const viaName = turnRowIteration(row.name);
      const iteration = num(row.data?.iteration) ?? viaName;
      if (iteration === null) continue;
      sawIteration = true;
      const turn = turnFor(attempt, iteration);
      // `llm.call` carries the live metrics; the post-hoc `llm.turn.N` row
      // carries the artifact. Neither overwrites a value the other supplied.
      turn.provider ??= str(row.data?.provider);
      turn.model ??= str(row.data?.model);
      turn.finishReason ??= str(row.data?.finishReason);
      turn.artifactId ??= row.artifactId;
      turn.durationMs ??= row.durationMs;
      const ti = num(row.data?.tokensIn);
      const to = num(row.data?.tokensOut);
      if (ti !== null && turn.tokensIn === null) {
        turn.tokensIn = ti;
        attempt.tokensIn += ti;
      }
      if (to !== null && turn.tokensOut === null) {
        turn.tokensOut = to;
        attempt.tokensOut += to;
      }
      continue;
    }

    if (row.kind === "tool") {
      sawTool = true;
      const callIndex = num(row.data?.callIndex);
      if (row.name.endsWith(EVIDENCE_SUFFIX)) {
        // Evidence carries callIndex but never iteration, so it cannot be
        // placed by turn — park it and attach once the call is known.
        if (callIndex === null) continue;
        const key = evidenceKey(stepId, attempt.attempt, callIndex);
        const list = pendingEvidence.get(key) ?? [];
        list.push(row);
        pendingEvidence.set(key, list);
        continue;
      }
      const call: ToolCallNode = {
        seq: row.seq,
        tool: row.name,
        callIndex,
        status: row.status,
        isError: row.data?.isError === true,
        durationMs: row.durationMs,
        summary: row.summary,
        evidenceArtifactId: null,
        resolvedVia: str(row.data?.resolvedVia),
      };
      const iteration = num(row.data?.iteration);
      if (iteration === null) {
        attempt.looseToolCalls.push(call);
      } else {
        sawIteration = true;
        turnFor(attempt, iteration).toolCalls.push(call);
      }
      continue;
    }
  }

  // Attach parked evidence to its call.
  for (const step of steps) {
    for (const attempt of step.attempts) {
      const calls = [
        ...attempt.turns.flatMap((t) => t.toolCalls),
        ...attempt.looseToolCalls,
      ];
      for (const call of calls) {
        if (call.callIndex === null) continue;
        const key = evidenceKey(step.stepId, attempt.attempt, call.callIndex);
        const evidence = pendingEvidence.get(key);
        if (!evidence?.length) continue;
        call.evidenceArtifactId =
          evidence.find((e) => e.artifactId)?.artifactId ?? null;
        if (!call.summary) {
          call.summary = evidence.find((e) => e.summary)?.summary ?? null;
        }
        if (evidence.some((e) => e.data?.isError === true)) call.isError = true;
      }
      attempt.turns.sort((a, b) => a.iteration - b.iteration);
      for (const turn of attempt.turns) {
        turn.toolCalls.sort((a, b) => a.seq - b.seq);
      }
    }
  }

  const totals = { tokensIn: 0, tokensOut: 0, toolCalls: 0 };
  for (const step of steps) {
    for (const attempt of step.attempts) {
      totals.tokensIn += attempt.tokensIn;
      totals.tokensOut += attempt.tokensOut;
      totals.toolCalls +=
        attempt.looseToolCalls.length +
        attempt.turns.reduce((n, t) => n + t.toolCalls.length, 0);
    }
  }

  return {
    runLevel,
    steps,
    // Tools present but no iteration anywhere means the producer predates the
    // turn fold; the panel should render flat rather than a one-turn tree.
    degraded: sawTool && !sawIteration,
    totals,
  };
}
