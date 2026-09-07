/**
 * control.fail — deterministic terminal stop for a compiled workflow.
 *
 * An ontology-compiled analysis agent sometimes has a legitimate "cannot
 * proceed" outcome that is NOT an exception inside the model step: the model
 * reports it honestly in its JSON (`blocking_note`, `stage_count: 0`,
 * `draft_request: null`). Until 2026-09-07 the manifest then emitted the
 * action's success event anyway, and the downstream ERP write received a null
 * payload, got an HTTP 400 back, and was retried for six minutes while the
 * canvas showed "running".
 *
 * The compiler now wires this tool behind a `condition` step (overlay
 * `blocking_outcomes`): when the blocking condition holds, this handler throws
 * and the step's `on_error: "terminal"` policy ends the run with the reason
 * preserved in `runs.error_message` — the failure is visible on the canvas and
 * nothing downstream fires.
 *
 * Deterministic by design: it validates nothing and decides nothing — the
 * decision was made upstream by the analysis — it only refuses, loudly, with
 * the reason it was handed.
 */

import { defineTool } from "@agentic/agent-kit";

export const CONTROL_FAIL_TOOL = "control.fail";
export const CONTROL_FAIL_DEFAULT_CODE = "blocked_outcome";
/** `kind` fact seen by declarative error ladders (`kind == blocked_outcome`). */
export const CONTROL_FAIL_KIND = "blocked_outcome";

const CODE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

export class ControlFailError extends Error {
  readonly code: string;
  readonly kind = CONTROL_FAIL_KIND;
  readonly detail: unknown;

  constructor(code: string, message: string, detail?: unknown) {
    // The `<kind>:` prefix is the serialization fallback `actionErrorFacts`
    // reads when only the message survives an Inngest step boundary.
    super(`${CONTROL_FAIL_KIND}: ${message}`);
    this.name = "ControlFailError";
    this.code = code;
    this.detail = detail;
  }
}

function normalizeCode(raw: unknown): string {
  return typeof raw === "string" && CODE_PATTERN.test(raw.trim())
    ? raw.trim()
    : CONTROL_FAIL_DEFAULT_CODE;
}

function normalizeMessage(raw: unknown, code: string): string {
  if (typeof raw === "string" && raw.trim()) return raw.trim();
  // A blocking outcome whose reason did not arrive is still a blocking
  // outcome; say so instead of inventing a reason.
  return `${code}: 工作流声明了阻断结果，但未提供原因说明 / blocking outcome declared without a reason`;
}

export const fail = defineTool({
  name: CONTROL_FAIL_TOOL,
  description:
    "Ends the run with a declared, human-readable reason. Args: { code?, " +
    "message?, detail? }. Always throws — pair it with a condition step so it " +
    "runs only when the analysis reported a blocking outcome, and with " +
    "on_error: \"terminal\" so the run fails instead of retrying.",
  async handler(ctx): Promise<never> {
    const args = (ctx.event?.data ?? {}) as Record<string, unknown>;
    const code = normalizeCode(args.code);
    throw new ControlFailError(
      code,
      normalizeMessage(args.message, code),
      args.detail,
    );
  },
});
