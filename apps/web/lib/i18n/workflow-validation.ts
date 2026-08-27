/**
 * Localises workflow validation issues.
 *
 * The API builds these sentences in English server-side — the runtime linter
 * writes `agent "x" triggers on "Y" but no agent emits it …` as a conflict
 * detail, and validateWorkflowManifest copies it straight onto the issue
 * (apps/api/src/services/workflow-authoring.ts, packages/runtime/src/lint.ts).
 * `WorkflowValidationIssue` carries only { path, code, severity, message }, so
 * there are no structured params to interpolate.
 *
 * Rather than change the contract, this rebuilds the sentence from the parts
 * that ARE machine-readable: the stable `code`, and the identifiers the server
 * consistently wraps in double quotes. An unknown code — or a message whose
 * quoted identifiers do not match what the template expects — falls back to the
 * server's English verbatim, so nothing can render a raw i18n key or a sentence
 * with holes in it.
 */

import type { Translate } from "@/app/portal/lib/preferences-context";

export interface ValidationIssueLike {
  path: string;
  code: string;
  /** Widened: the import wizard's CommitIssue types this as a plain string. */
  severity: string;
  message: string;
}

/**
 * Codes whose English message quotes exactly the identifiers the localized
 * template needs, in order. The number is how many quoted values the template
 * consumes; a message that yields fewer falls back to English.
 */
const QUOTED_ARITY: Readonly<Record<string, number>> = {
  dangling_trigger: 2,
  dangling_emitter: 2,
  duplicate_agent_name: 1,
  duplicate_kebab_id: 1,
  unknown_tool: 1,
  orphan_actor: 1,
  kebab_id_collision: 1,
  silent_rename: 2,
  unknown_subflow: 1,
  broken_subflow: 1,
  trigger_cycle: 1,
};

/** Codes translated without needing any identifier from the message. */
const PLAIN_CODES = new Set([
  "missing_system_prompt",
  "prompt_rubric_incomplete",
  "prompt_substance_missing",
  "provider_not_configured",
  "model_not_configured",
  "agent_limit_exceeded",
  "invalid_manifest",
  "concurrency_excess",
  "invalid_cron",
  "schedule_env_disabled",
  "schedule_env_unconfigured",
  "prompt_injection_smell",
  "schema_version_downgrade",
]);

/** Every value the server wrapped in double quotes, in order of appearance. */
export function quotedIdentifiers(message: string): string[] {
  return Array.from(message.matchAll(/"([^"]+)"/g), (match) => match[1]!);
}

const KNOWN_SEVERITIES = new Set(["error", "warning", "info"]);

export function localizeValidationSeverity(
  t: Translate,
  severity: string,
): string {
  return KNOWN_SEVERITIES.has(severity)
    ? t(`workflowValidation.severity.${severity}`)
    : severity.toUpperCase();
}

/**
 * The issue sentence in the active language, or the server's English when this
 * code is not translatable here.
 */
export function localizeValidationMessage(
  t: Translate,
  issue: ValidationIssueLike,
): string {
  if (PLAIN_CODES.has(issue.code)) {
    // These carry their detail after a colon (e.g. the list of missing rubric
    // sections); keep that tail so nothing is lost in translation.
    const tail = issue.message.includes(": ")
      ? issue.message.slice(issue.message.indexOf(": ") + 2)
      : "";
    return tail
      ? `${t(`workflowValidation.issue.${issue.code}`)}: ${tail}`
      : t(`workflowValidation.issue.${issue.code}`);
  }
  const arity = QUOTED_ARITY[issue.code];
  if (arity === undefined) return issue.message;
  const quoted = quotedIdentifiers(issue.message);
  if (quoted.length < arity) return issue.message;
  return t(`workflowValidation.issue.${issue.code}`, {
    first: quoted[0] ?? "",
    second: quoted[1] ?? "",
  });
}

/** `WARNING · agents[0].trigger[0]: …` with the parts that can be localized. */
export function formatValidationIssue(
  t: Translate,
  issue: ValidationIssueLike,
): string {
  return `${localizeValidationSeverity(t, issue.severity)} · ${issue.path}: ${localizeValidationMessage(t, issue)}`;
}
