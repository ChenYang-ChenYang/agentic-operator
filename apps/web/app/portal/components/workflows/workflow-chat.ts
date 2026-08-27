/**
 * Pure logic for the workflow Run console's chat mode.
 *
 * Kept free of React so it can be unit-tested directly (the web vitest project
 * runs in `environment: "node"`), and so the rules that decide when a workflow
 * is chattable live in one readable place rather than inside a 2,400-line
 * component.
 */

import type {
  AgentDefinitionV2,
  WorkflowRunEntrypoint,
  WorkflowTestRunResponse,
} from "@agentic/contracts";
import {
  assistantTextFromValue,
  assistantTextOutputKeys,
} from "@/app/portal/components/agent-studio/chat-model";

/** Matches the server-side cap in WorkflowTestRunBodySchema. */
export const MAX_CHAT_HISTORY_TURNS = 20;

export interface WorkflowChatTurn {
  role: "user" | "assistant";
  content: string;
}

export interface WorkflowChatBubble {
  role: "user" | "assistant";
  content: string;
  /** Set when more than one agent produced a terminal output this turn. */
  byline?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The entrypoint a chat composer can drive: one prompt field and nothing else
 * the person would have to fill in.
 *
 * `requiresRawPayload` is the important half. It is true whenever any listener
 * binds an input through a `path` or `template` expression, which means the run
 * genuinely needs a structured payload that a single message cannot supply.
 */
export function chatCapableEntrypoint(
  entrypoints: readonly WorkflowRunEntrypoint[],
): WorkflowRunEntrypoint | null {
  for (const entrypoint of entrypoints) {
    if (entrypoint.source !== "external") continue;
    if (entrypoint.requiresRawPayload) continue;
    const prompts = entrypoint.inputs.filter((input) => input.kind === "prompt");
    if (prompts.length !== 1) continue;
    const otherRequired = entrypoint.inputs.some(
      (input) => input.kind !== "prompt" && input.required,
    );
    if (otherRequired) continue;
    return entrypoint;
  }
  return null;
}

/**
 * Whether chat should be the DEFAULT tab, as opposed to merely available.
 *
 * Deliberately gated on an explicit `extensions.starter` marker rather than on
 * the shape of the entrypoint. Every on-disk v1 tenant manifest normalises to a
 * `prompt` + `payload` port pair with no trigger_bindings, so a shape heuristic
 * alone would silently flip a production tenant's real entrypoint into a chat
 * box. Opting in is the tenant author's decision, not an inference.
 */
export function chatIsDefault(
  agents: readonly AgentDefinitionV2[],
  entrypoint: WorkflowRunEntrypoint | null,
): boolean {
  if (!entrypoint) return false;
  const listeners = agents.filter((agent) =>
    entrypoint.listenerAgentIds.includes(agent.id),
  );
  if (listeners.length === 0) return false;
  return listeners.every((agent) => {
    const extensions = (agent as { extensions?: unknown }).extensions;
    return isRecord(extensions) && extensions.starter === true;
  });
}

/**
 * Turn a completed draft test run into the bubbles the transcript shows.
 *
 * Degrades rather than going blank: a structured output is pretty-printed, and
 * a run that produced no terminal output at all surfaces the failure message —
 * an empty bubble would read as "the agent ignored me".
 */
export function replyBubblesFromRun(
  response: WorkflowTestRunResponse,
  agents: readonly AgentDefinitionV2[],
): WorkflowChatBubble[] {
  const outputs = response.terminalOutputs ?? [];
  if (outputs.length > 0) {
    const multiple = outputs.length > 1;
    return outputs.map((terminal) => {
      const agent = agents.find(
        (candidate) => candidate.id === terminal.agentId,
      );
      const keys = agent ? assistantTextOutputKeys(agent.outputs) : [];
      const text = assistantTextFromValue(terminal.output, keys);
      return {
        role: "assistant" as const,
        content: text ?? JSON.stringify(terminal.output, null, 2),
        ...(multiple ? { byline: terminal.agentTitle } : {}),
      };
    });
  }

  const failed = [...(response.agentRuns ?? [])]
    .reverse()
    .find((run) => run.error);
  const message =
    failed?.error?.message ??
    (response.warnings ?? [])[0] ??
    "The run finished without producing a reply.";
  return [{ role: "assistant", content: message }];
}

/** The bounded window sent with the next turn. Server re-bounds regardless. */
export function historyForNextTurn(
  turns: readonly WorkflowChatTurn[],
): WorkflowChatTurn[] {
  return turns
    .slice(-MAX_CHAT_HISTORY_TURNS)
    .map((turn) => ({ role: turn.role, content: turn.content }));
}

/**
 * True when fewer agents ran than the manifest declares — usually because a
 * downstream agent's `trigger` does not match anything the upstream agent
 * emits. Silent in the transcript otherwise, so the console says it out loud.
 */
export function hasIncompleteCascade(
  response: WorkflowTestRunResponse,
  agents: readonly AgentDefinitionV2[],
): boolean {
  return agents.length > 1 && response.summary.agentRuns < agents.length;
}
