/**
 * W3 — cross-run reads for the 推理审计 (reasoning / rule-audit) page.
 *
 *   - `listRecentTurns` — the LLM-response feed: recent captured `llm_turns`
 *     across all of a tenant's runs, joined to run + agent so each item shows
 *     which agent/run produced it. Powers the live "推理流" lens.
 *   - `listRuleAudit` — recent rule-check / gate decisions (the zhaopin
 *     rule-check agents emit MATCH_RULE_CHECK_PASSED/FAILED, CANDIDATE_IDENTITY
 *     _CHECKED, …). Name-pattern based so it works for any tenant that models a
 *     gate as a PASS/FAIL event, with a derived verdict + resolved payload.
 */

import { alias } from "drizzle-orm/sqlite-core";
import { and, desc, eq, isNull, like, or, sql } from "drizzle-orm";
import { agents, events, getDb, llmTurns, runs } from "@agentic/db";
import { resolvePayloadRef } from "./runs";
import { resolveTenantId } from "./reasoning";

export interface ReasoningTurn {
  id: string;
  runId: string;
  /** steps.id of the step that produced this turn, when the runtime recorded one. */
  stepId: string | null;
  agentName: string | null;
  agentTitle: string | null;
  subject: string | null;
  runStatus: string;
  ord: number;
  responseText: string | null;
  reasoning: string | null;
  toolCalls: Array<{ name: string; input: unknown }>;
  provider: string | null;
  model: string | null;
  finishReason: string | null;
  tokensIn: number | null;
  tokensOut: number | null;
  latencyMs: number | null;
  createdAt: Date | null;
}

/**
 * Recent captured LLM turns across the tenant's runs, newest first. Optional
 * `agent` filter (by agent name) focuses the feed on e.g. a rule-check agent;
 * optional `run` filter narrows to a single execution.
 */
export function listRecentTurns(
  tenantSlug: string,
  opts: { limit?: number; agent?: string; run?: string } = {},
): ReasoningTurn[] {
  const db = getDb();
  const tenantId = resolveTenantId(tenantSlug);
  if (!tenantId) return [];
  const limit = Math.min(200, Math.max(1, opts.limit ?? 60));

  const where = [
    eq(llmTurns.tenantId, tenantId),
    isNull(runs.deletedAt),
  ];
  if (opts.agent) where.push(eq(agents.name, opts.agent));
  // Scoping to one run is what the workflow monitor's timeline needs: it shows
  // a single execution and has to line each turn up with the step that made
  // it, not sample the tenant-wide feed.
  if (opts.run) where.push(eq(llmTurns.runId, opts.run));

  const rows = db
    .select({
      id: llmTurns.id,
      runId: llmTurns.runId,
      // Needed to line a turn up with the step that produced it; the monitor
      // timeline joins on (stepId, ord).
      stepId: llmTurns.stepId,
      agentName: agents.name,
      agentTitle: agents.title,
      subject: runs.subject,
      runStatus: runs.status,
      ord: llmTurns.ord,
      responseText: llmTurns.responseText,
      reasoning: llmTurns.reasoning,
      toolCallsJson: llmTurns.toolCallsJson,
      provider: llmTurns.provider,
      model: llmTurns.model,
      finishReason: llmTurns.finishReason,
      tokensIn: llmTurns.tokensIn,
      tokensOut: llmTurns.tokensOut,
      latencyMs: llmTurns.latencyMs,
      createdAt: llmTurns.createdAt,
    })
    .from(llmTurns)
    .innerJoin(runs, eq(runs.id, llmTurns.runId))
    .leftJoin(agents, eq(agents.id, runs.agentId))
    .where(and(...where))
    .orderBy(desc(llmTurns.createdAt), desc(llmTurns.ord))
    .limit(limit)
    .all();

  return rows.map(({ toolCallsJson, ...r }) => ({
    ...r,
    toolCalls: Array.isArray(toolCallsJson)
      ? (toolCallsJson as Array<{ name: string; input: unknown }>)
      : [],
  }));
}

export interface RuleAuditRow {
  id: string;
  name: string;
  subject: string | null;
  receivedAt: Date | null;
  sourceAgentName: string | null;
  sourceAgentTitle: string | null;
  /** pass | fail | neutral — derived from the event name. */
  verdict: "pass" | "fail" | "neutral";
  /** The consuming run (if any) so the UI can deep-link to its reasoning. */
  consumerRunId: string | null;
  payload: unknown;
}

const sourceAgentsAlias = alias(agents, "source_agents");

function deriveVerdict(name: string): "pass" | "fail" | "neutral" {
  const u = name.toUpperCase();
  if (/FAIL|REJECT|BLOCK|DENIED|VIOLATION/.test(u)) return "fail";
  if (/PASS|OK|APPROV|CHECKED|CLEARED/.test(u)) return "pass";
  return "neutral";
}

/**
 * Recent rule-check / gate decisions, newest first. Name-pattern based: any
 * event whose name looks like a rule/gate verdict. Each row carries a derived
 * verdict, the emitting agent, the consuming run (for a deep-link to its
 * reasoning), and the resolved decision payload (bounded).
 */
export async function listRuleAudit(
  tenantSlug: string,
  opts: { limit?: number } = {},
): Promise<RuleAuditRow[]> {
  const db = getDb();
  const tenantId = resolveTenantId(tenantSlug);
  if (!tenantId) return [];
  const limit = Math.min(200, Math.max(1, opts.limit ?? 60));

  const pat = (s: string) => like(events.name, s);
  const rows = db
    .select({
      id: events.id,
      name: events.name,
      subject: events.subject,
      receivedAt: events.receivedAt,
      payloadRef: events.payloadRef,
      sourceAgentName: sourceAgentsAlias.name,
      sourceAgentTitle: sourceAgentsAlias.title,
    })
    .from(events)
    .leftJoin(sourceAgentsAlias, eq(sourceAgentsAlias.id, events.sourceAgentId))
    .where(
      and(
        eq(events.tenantId, tenantId),
        sql`${events.deletedAt} IS NULL`,
        or(
          pat("%RULE%"),
          pat("%CHECK%"),
          pat("%AUDIT%"),
          pat("%PASSED%"),
          pat("%FAILED%"),
          pat("%REJECT%"),
        )!,
      ),
    )
    .orderBy(desc(events.receivedAt))
    .limit(limit)
    .all();

  // Resolve each decision's payload + find its consuming run (best-effort).
  return Promise.all(
    rows.map(async ({ payloadRef, ...r }) => {
      const consumer = db
        .select({ runId: runs.id })
        .from(runs)
        .where(
          and(
            eq(runs.triggerEventId, r.id),
            eq(runs.tenantId, tenantId),
            isNull(runs.deletedAt),
          ),
        )
        .all()[0];
      return {
        ...r,
        verdict: deriveVerdict(r.name),
        consumerRunId: consumer?.runId ?? null,
        payload: await resolvePayloadRef(payloadRef),
      };
    }),
  );
}
