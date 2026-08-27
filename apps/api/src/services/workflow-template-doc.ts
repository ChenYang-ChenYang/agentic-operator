/**
 * The downloadable, self-teaching workflow manifest.
 *
 * The file has to satisfy three things at once: a person can read it and learn
 * the format, they can edit it in any text editor, and they can drop it back
 * onto Import manifest and have it work. That rules out JSONC — every ingest
 * path is a strict `JSON.parse` (ImportManifestModal.tsx:118,374,653 and
 * manifest-import.ts:428,480), so `//` comments would download fine and fail on
 * re-upload, which is the worst possible outcome for a "download, edit, upload"
 * feature.
 *
 * So the annotations are ordinary JSON: arrays of plain-English strings under
 * `_readme`, `_rules` and `_doc`. They survive validation because the manifest
 * and agent schemas are `.passthrough()` (agent-definition.ts) and they survive
 * the round trip unchanged.
 *
 * Two placement rules are load-bearing, not stylistic:
 *
 *  1. Never annotate INSIDE `schema`, `trigger_bindings`, `output_bindings`,
 *     `input_data` or `extensions`. Port schemas are compiled and validated by
 *     Ajv in `strict: true` mode (agent-execution.ts:15-22), so a stray key in a
 *     schema throws at RUN time rather than at import time — the worst place to
 *     find out. `trigger_bindings`/`output_bindings` are records-of-records
 *     where a string value is a validation error outright. Inside a `schema`,
 *     use JSON Schema's own `description`, which is legal and additionally
 *     improves the output-contract text the model sees.
 *
 *  2. Never name an annotation key so that it ends in `_env`, `_ref` or
 *     `_secret_name`, and never let a sample value look like a credential. The
 *     workflow secret scanner walks EVERY key on every create/save/validate/
 *     import (workflow-secret-policy.ts) and routes those suffixes through
 *     `referenceIssue`, so a doc key such as `_doc:api_key_env` would hard-fail
 *     its own file. Whole-array annotations keep us clear of that entirely.
 */

import type { WorkflowManifestV2 } from "@agentic/contracts";
import { instantiateBlankWorkflow } from "./workflow-templates";

export const WORKFLOW_TEMPLATE_FILENAME = "workflow-template.json";

/**
 * Subtrees whose shape is validated strictly downstream. Annotations must never
 * be written into any of these.
 */
const UNANNOTATABLE_KEYS = new Set([
  "schema",
  "trigger_bindings",
  "output_bindings",
  "input_data",
  "extensions",
]);

const README = [
  "This is a workflow: one or more agents wired together by events.",
  "",
  "How it runs: something emits the event named in an agent's \"trigger\". That agent runs its \"actions\" against the large language model, using \"ontology_instructions\" as its system prompt. When it finishes it emits the event named in \"triggered_event\".",
  "",
  "To chain a second step, set the next agent's \"trigger\" to the first agent's \"triggered_event\". There is an \"_example_second_agent\" at the bottom of this file you can paste into \"agents\" to do exactly that.",
  "",
  "To use this file: edit it in any text editor, then drag it onto Workflows -> Import manifest in the portal. Keep the filename starting with \"workflow\".",
];

const RULES = [
  "Keys starting with _ are comments. They are ignored by the system and you can delete any of them.",
  "This file must stay valid JSON. Do not add // comments — the importer will reject the file.",
  'Keep "generated": true on every agent. It is what allows an agent defined purely in this file to run.',
  'Every agent needs exactly one input with "kind": "prompt" and "id": "prompt". That is where the person\'s message arrives.',
  'Event names in "trigger" and "triggered_event" are free text, but they must match exactly between the agent that emits and the agent that listens.',
  '"ontology_instructions" is the system prompt. "user_prompt_template" is optional extra context appended to each turn — leave it out and the person\'s message is sent on its own.',
  'Do not put "retries" on an action. Retries belong on the agent.',
  'Leave "provider" and "model" out unless you know the target workspace has that provider configured; otherwise the workflow will not run there.',
];

const AGENT_DOC = [
  '"id" and "name" identify this agent. Keep them unique within the workspace.',
  '"title" and "description" are what a person sees on the canvas.',
  '"trigger" — the event or events that wake this agent up.',
  '"triggered_event" — the event or events it emits when it finishes.',
  '"ontology_instructions" — THE SYSTEM PROMPT. Who the agent is and how it should answer. Edit this first.',
  '"user_prompt_template" — optional. Extra context added to every turn, e.g. "{{json inputs.payload}}". Omit it to send just the person\'s message.',
  '"inputs" — what the agent receives. Exactly one must have "kind": "prompt".',
  '"outputs" — what the agent must return. A single output with "type": "string" gives you a plain conversational reply.',
  '"actions" — the ordered steps. "type": "logic" means "ask the model". "action_prompt" is the instruction for that one step.',
  '"tool_use" — names of tools this agent may call. Browse the available ones on the Agentic Tools page. An empty list means no tools.',
  '"output_bindings" — maps this agent\'s outputs onto the event it emits, so the next agent can read them.',
];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Deep clone minus `provider` / `model`, which are workspace-specific. */
function stripModelSelection<T>(value: T): T {
  const clone = structuredClone(value) as unknown;
  if (isPlainObject(clone) && Array.isArray(clone.agents)) {
    for (const agent of clone.agents) {
      if (!isPlainObject(agent)) continue;
      delete agent.provider;
      delete agent.model;
    }
  }
  return clone as T;
}

/** A second agent, ready to paste, that consumes the first agent's event. */
function exampleSecondAgent(
  manifest: WorkflowManifestV2,
): Record<string, unknown> {
  const first = manifest.agents[0];
  const handoff = first?.triggered_event?.[0] ?? "WORKFLOW_COMPLETED";
  return {
    _doc: [
      "Paste this object into the \"agents\" array (after the first agent) to add a second step.",
      `It listens for "${handoff}", which is what the first agent emits — that is the whole mechanism for chaining agents.`,
      "Rename it, give it its own system prompt, and change its triggered_event to whatever should come after it.",
    ],
    id: "second-agent",
    name: "secondAgent",
    title: "Second agent",
    description: "Takes the first agent's answer and does something with it.",
    actor: ["Agent"],
    stage: 2,
    trigger: [handoff],
    inputs: [
      {
        id: "prompt",
        label: "Message",
        kind: "prompt",
        required: false,
        schema: {
          type: "string",
          minLength: 1,
          description: "The text handed over by the previous agent.",
        },
        default: "Continue.",
        sensitivity: "none",
      },
    ],
    ontology_instructions:
      "You review the answer you are given and rewrite it as a single short paragraph. Do not add facts that are not already present.",
    generated: true,
    tool_use: [],
    actions: [
      {
        id: "review",
        order: "1",
        name: "review",
        description: "Review and rewrite the answer.",
        type: "logic",
        action_prompt:
          "Rewrite the supplied answer as one short paragraph, preserving every fact.",
        timeout_s: 120,
      },
    ],
    outputs: [
      {
        id: "reply",
        label: "Reply",
        required: true,
        schema: {
          type: "string",
          minLength: 1,
          description: "The rewritten answer.",
        },
        sensitivity: "none",
      },
    ],
    triggered_event: ["SECOND_AGENT_COMPLETED"],
    output_bindings: { SECOND_AGENT_COMPLETED: { reply: { output: "reply" } } },
  };
}

/**
 * Return a copy of `manifest` with plain-English annotations added. The result
 * is valid JSON, passes workflow validation, and re-imports unchanged.
 */
export function annotateWorkflowManifest(
  manifest: WorkflowManifestV2,
): Record<string, unknown> {
  const clean = stripModelSelection(manifest);
  const annotated: Record<string, unknown> = {
    _readme: README,
    _rules: RULES,
    ...(clean as unknown as Record<string, unknown>),
  };
  // `_doc` is added at the agent level only, and every field below it is copied
  // verbatim. Nothing recurses, which is precisely why no annotation can land
  // inside a compiled port schema or a binding record — see UNANNOTATABLE_KEYS
  // and the test that walks the emitted document to prove it.
  annotated.agents = (clean.agents ?? []).map((agent) => ({
    _doc: AGENT_DOC,
    ...(agent as unknown as Record<string, unknown>),
  }));
  annotated._example_second_agent = exampleSecondAgent(clean);
  return annotated;
}

/** The annotated blank starter, portable across workspaces. */
export function blankTemplateForDownload(): Record<string, unknown> {
  return annotateWorkflowManifest(
    instantiateBlankWorkflow({ slug: "my-first-workflow" }),
  );
}

export { UNANNOTATABLE_KEYS as WORKFLOW_TEMPLATE_UNANNOTATABLE_KEYS };
