/**
 * Conversation-history bounding, shared by every surface that replays prior
 * turns into a model call.
 *
 * Lifted verbatim out of `studio-runner.ts` when the workflow draft test runner
 * gained chat continuity, so both surfaces enforce ONE budget. The runtime
 * splices these turns between the system message and the current user message
 * (`compileAgentPrompts`, packages/runtime/src/agent-execution.ts:439-447), and
 * separately caps at `MAX_AGENT_CONVERSATION_MESSAGES` — bounding here is what
 * keeps a long chat from silently pushing the system prompt out of budget.
 */

import type { AgentConversationTurn } from "@agentic/runtime";

export const MAX_CONVERSATION_HISTORY_MESSAGES = 20;
export const MAX_CONVERSATION_HISTORY_BYTES = 64 * 1024;

export function conversationHistoryBytes(
  history: AgentConversationTurn[],
): number {
  return Buffer.byteLength(JSON.stringify(history), "utf8");
}

/**
 * Binary-search the longest code-point prefix that fits the byte budget, so a
 * single oversized turn is trimmed rather than dropped — and never split
 * mid-surrogate-pair.
 */
export function truncateConversationTurn(
  turn: AgentConversationTurn,
): AgentConversationTurn {
  const codePoints = Array.from(turn.content);
  let low = 0;
  let high = codePoints.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const candidate = [
      { ...turn, content: codePoints.slice(0, middle).join("") },
    ];
    if (conversationHistoryBytes(candidate) <= MAX_CONVERSATION_HISTORY_BYTES) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return { ...turn, content: codePoints.slice(0, low).join("") };
}

/**
 * Keep the most recent turns within both the message-count and byte budgets.
 * Drops from the front (oldest first); only when a single turn is itself over
 * budget does it truncate that turn's content.
 */
export function boundConversationHistory(
  history: AgentConversationTurn[],
): AgentConversationTurn[] {
  const bounded = history
    .slice(-MAX_CONVERSATION_HISTORY_MESSAGES)
    .map((turn) => ({ role: turn.role, content: turn.content }));
  while (
    bounded.length > 1 &&
    conversationHistoryBytes(bounded) > MAX_CONVERSATION_HISTORY_BYTES
  ) {
    bounded.shift();
  }
  if (
    bounded.length === 1 &&
    conversationHistoryBytes(bounded) > MAX_CONVERSATION_HISTORY_BYTES
  ) {
    bounded[0] = truncateConversationTurn(bounded[0]!);
  }
  return bounded;
}
