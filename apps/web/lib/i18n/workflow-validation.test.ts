import { describe, expect, it } from "vitest";
import { en } from "./en";
import { zh } from "./zh";
import { translate } from "./index";
import {
  formatValidationIssue,
  localizeValidationMessage,
  localizeValidationSeverity,
  quotedIdentifiers,
  type ValidationIssueLike,
} from "./workflow-validation";

/** Bound to the real dictionaries, matching how the app calls t(). */
const t = (key: string, vars?: Record<string, string | number>) =>
  translate("en", key, vars);
const tz = (key: string, vars?: Record<string, string | number>) =>
  translate("zh", key, vars);

function issue(over: Partial<ValidationIssueLike> = {}): ValidationIssueLike {
  return {
    path: "agents[0].trigger[0]",
    code: "dangling_trigger",
    severity: "warning",
    message:
      'agent "definevideomarketingbrief" triggers on "SHORT_VIDEO_MARKETING_REQUEST" but no agent emits it (neither in the import nor the live workflow)',
    ...over,
  } as ValidationIssueLike;
}

describe("quotedIdentifiers", () => {
  it("pulls the server's quoted identifiers in order", () => {
    expect(quotedIdentifiers(issue().message)).toEqual([
      "definevideomarketingbrief",
      "SHORT_VIDEO_MARKETING_REQUEST",
    ]);
  });

  it("returns nothing for an unquoted message", () => {
    expect(quotedIdentifiers("no identifiers here")).toEqual([]);
  });
});

describe("localizeValidationMessage", () => {
  it("rebuilds the sentence in Chinese, keeping the identifiers", () => {
    const out = localizeValidationMessage(tz, issue());
    expect(out).toContain("definevideomarketingbrief");
    expect(out).toContain("SHORT_VIDEO_MARKETING_REQUEST");
    // The prose is translated, not the identifiers.
    expect(out).toContain("监听");
    expect(out).not.toContain("triggers on");
  });

  it("still reads correctly in English", () => {
    expect(localizeValidationMessage(t, issue())).toBe(
      'Agent "definevideomarketingbrief" listens for "SHORT_VIDEO_MARKETING_REQUEST", but no agent emits that event.',
    );
  });

  it("falls back to the server message for an unknown code", () => {
    const unknown = issue({
      code: "some_future_code",
      message: "something the client has never heard of",
    });
    expect(localizeValidationMessage(tz, unknown)).toBe(
      "something the client has never heard of",
    );
  });

  it("falls back when the message lacks the identifiers the template needs", () => {
    const malformed = issue({ message: "agent triggers on something" });
    expect(localizeValidationMessage(tz, malformed)).toBe(
      "agent triggers on something",
    );
  });

  it("keeps the trailing detail of a list-style issue", () => {
    const rubric = issue({
      code: "prompt_rubric_incomplete",
      message: "prompt is missing rubric sections: role, mission, inputs",
    });
    const out = localizeValidationMessage(tz, rubric);
    expect(out).toContain("role, mission, inputs");
    expect(out).toContain("缺少");
  });

  it("translates a plain code with no detail tail", () => {
    const plain = issue({
      code: "missing_system_prompt",
      message: "automated agents require a complete system prompt",
    });
    expect(localizeValidationMessage(tz, plain)).toBe(
      "该智能体需要先填写系统提示词才能运行。",
    );
  });
});

describe("localizeValidationSeverity", () => {
  it("translates the known severities", () => {
    expect(localizeValidationSeverity(tz, "warning")).toBe("警告");
    expect(localizeValidationSeverity(tz, "error")).toBe("错误");
    expect(localizeValidationSeverity(t, "warning")).toBe("WARNING");
  });

  it("upper-cases an unrecognised severity rather than printing a key", () => {
    expect(localizeValidationSeverity(tz, "critical")).toBe("CRITICAL");
  });
});

describe("formatValidationIssue", () => {
  it("keeps the machine-readable path beside the translated prose", () => {
    const out = formatValidationIssue(tz, issue());
    expect(out.startsWith("警告 · agents[0].trigger[0]: ")).toBe(true);
  });
});

describe("dictionary coverage", () => {
  it("has the same validation keys in both languages", () => {
    const enKeys = Object.keys(
      (en as unknown as { workflowValidation: { issue: object } })
        .workflowValidation.issue,
    ).sort();
    const zhKeys = Object.keys(
      (zh as unknown as { workflowValidation: { issue: object } })
        .workflowValidation.issue,
    ).sort();
    expect(zhKeys).toEqual(enKeys);
  });
});
