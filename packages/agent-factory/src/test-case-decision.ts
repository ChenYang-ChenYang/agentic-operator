export type TestCaseDecision =
  | "approve"
  | "regenerate"
  | "supply_data"
  | "save_draft";

export interface ParsedTestCaseDecision {
  decision: TestCaseDecision;
  note: string;
  raw: string;
  source: "tag" | "phrase";
}

/**
 * Whether a mailbox message is reserved for the test-case gate.
 *
 * This intentionally recognizes unsupported/malformed decision tags too. A
 * wrong-gate handler must re-queue such a message instead of consuming it as a
 * free-form clarification answer. Parsing the decision itself remains strict.
 */
export function isTestCaseDecisionTaggedMessage(input: string): boolean {
  return /^\[测试用例决策(?:\]|[:：])/i.test(input.trimStart());
}

function decisionForTaggedToken(token: string): TestCaseDecision | null {
  const normalized = token.trim().toLowerCase().replace(/\s+/g, " ");
  if (normalized === "执行" || normalized === "approve") return "approve";
  if (normalized === "重新生成" || normalized === "regenerate")
    return "regenerate";
  if (
    normalized === "补数据" ||
    normalized === "supply_data" ||
    normalized === "supply-data" ||
    normalized === "supply data" ||
    normalized === "edit"
  )
    return "supply_data";
  if (
    normalized === "保存设计稿" ||
    normalized === "保存草稿" ||
    normalized === "save_draft" ||
    normalized === "save-draft" ||
    normalized === "save draft"
  )
    return "save_draft";
  return null;
}

/**
 * Parse only explicit test-case decisions.
 *
 * Supported inputs are an exact `[测试用例决策: ...]` protocol tag, a small set
 * of exact command phrases, or a regenerate command followed by an explicit
 * punctuation delimiter and note. Ordinary conversational text must not open
 * or close a deployment gate.
 */
export function parseTestCaseDecision(
  input: string,
): ParsedTestCaseDecision | null {
  const raw = input.trim();
  if (!raw) return null;

  const tagged = raw.match(/^\[测试用例决策[:：]\s*([^\]]+?)\]\s*([\s\S]*)$/i);
  if (tagged) {
    const decision = decisionForTaggedToken(tagged[1] ?? "");
    if (!decision) return null;
    return {
      decision,
      note: (tagged[2] ?? "").trim(),
      raw,
      source: "tag",
    };
  }

  // A reserved but malformed/unsupported tag is never treated as a plain
  // phrase. The caller may keep it queued for the correct gate or reject it.
  if (isTestCaseDecisionTaggedMessage(raw)) return null;

  if (/^(?:执行|确认执行|approve)$/i.test(raw)) {
    return { decision: "approve", note: "", raw, source: "phrase" };
  }
  if (/^(?:重新生成|regenerate|重做)$/i.test(raw)) {
    return { decision: "regenerate", note: "", raw, source: "phrase" };
  }
  const regenerateWithNote = raw.match(
    /^(?:重新生成|regenerate|重做)[，,：:]\s*([\s\S]+)$/i,
  );
  if (regenerateWithNote) {
    return {
      decision: "regenerate",
      note: (regenerateWithNote[1] ?? "").trim(),
      raw,
      source: "phrase",
    };
  }
  if (/^(?:补数据|补充测试数据|supply(?:\s+|[_-])data)$/i.test(raw)) {
    return { decision: "supply_data", note: "", raw, source: "phrase" };
  }
  if (/^(?:保存设计稿|保存草稿|save(?:\s+|[_-])draft)$/i.test(raw)) {
    return { decision: "save_draft", note: "", raw, source: "phrase" };
  }
  return null;
}

/**
 * Recognize an unambiguous request to leave test preparation and persist only
 * an unverified draft.
 *
 * The ordinary test-approval protocol remains intentionally exact. This
 * helper exists for a narrower case: while answering a test-fixture
 * clarification, the user may explicitly say "directly call save_draft" (or
 * its Chinese equivalent) instead of replying with another fixture value.
 * Clause anchoring keeps explanatory/negative prose such as "不要直接
 * save_draft" from becoming a control-plane decision.
 */
export function isExplicitDraftOnlyDirective(input: string): boolean {
  const raw = input.trim();
  if (!raw) return false;
  if (parseTestCaseDecision(raw)?.decision === "save_draft") return true;

  const clauseStart = String.raw`(?:^|[，,。；;：:\n])\s*`;
  const imperative = String.raw`(?:(?:当前|现在)\s*)?(?:(?:只|仅)(?:要求)?|请(?:直接)?|直接)`;
  const machineCommand = new RegExp(
    `${clauseStart}${imperative}\\s*(?:调用\\s*)?save(?:\\s+|[_-])draft\\b`,
    "i",
  );
  const chineseCommand = new RegExp(
    `${clauseStart}${imperative}[^。；;\\n]{0,120}(?:保存|保留)[^。；;\\n]{0,60}(?:未验证)?(?:设计稿|代码草稿|草稿)`,
    "i",
  );
  return machineCommand.test(raw) || chineseCommand.test(raw);
}
