import { describe, expect, it } from "vitest";
import {
  MIN_PURPOSE_CHARS,
  canCreateWorkflow,
  newWorkflowRequirements,
  unmetRequirements,
  type RequirementInput,
} from "./new-workflow-requirements";

function input(overrides: Partial<RequirementInput> = {}): RequirementInput {
  return {
    path: "blank",
    name: "Support answers",
    slug: "support-answers",
    purpose: "",
    hasPreview: false,
    previewIsCurrent: false,
    templateId: "",
    cloneSlug: "",
    ...overrides,
  };
}

function ids(list: { id: string }[]): string[] {
  return list.map((item) => item.id);
}

describe("identity requirements", () => {
  it("names the missing field rather than just blocking", () => {
    expect(ids(unmetRequirements(input({ name: "  " })))).toEqual([
      "displayName",
    ]);
    expect(ids(unmetRequirements(input({ slug: "" })))).toEqual(["slug"]);
  });

  it("lets a complete blank workflow through", () => {
    expect(canCreateWorkflow(input())).toBe(true);
  });
});

describe("generate path", () => {
  const generate = (overrides: Partial<RequirementInput> = {}) =>
    input({ path: "generate", ...overrides });

  it("asks for a long enough purpose before anything else on that path", () => {
    expect(ids(unmetRequirements(generate({ purpose: "too short" })))).toEqual([
      "purpose",
      "generated",
    ]);
  });

  it("accepts a purpose at exactly the minimum length", () => {
    const purpose = "x".repeat(MIN_PURPOSE_CHARS);
    expect(ids(unmetRequirements(generate({ purpose })))).toEqual(["generated"]);
  });

  it("tells the operator to press Generate — the non-obvious blocker", () => {
    const purpose = "x".repeat(MIN_PURPOSE_CHARS);
    expect(ids(unmetRequirements(generate({ purpose })))).toContain("generated");
  });

  it("surfaces a stale preview only once a preview exists", () => {
    const purpose = "x".repeat(MIN_PURPOSE_CHARS);
    // No preview yet: "regenerate" would be noise on top of "generate".
    expect(
      ids(newWorkflowRequirements(generate({ purpose }))),
    ).not.toContain("previewCurrent");
    // Preview exists but the inputs moved on.
    expect(
      ids(
        unmetRequirements(
          generate({ purpose, hasPreview: true, previewIsCurrent: false }),
        ),
      ),
    ).toEqual(["previewCurrent"]);
  });

  it("is creatable once the preview matches the current inputs", () => {
    expect(
      canCreateWorkflow(
        generate({
          purpose: "x".repeat(MIN_PURPOSE_CHARS),
          hasPreview: true,
          previewIsCurrent: true,
        }),
      ),
    ).toBe(true);
  });
});

describe("template and clone paths", () => {
  it("requires a template selection", () => {
    expect(ids(unmetRequirements(input({ path: "template" })))).toEqual([
      "template",
    ]);
    expect(
      canCreateWorkflow(input({ path: "template", templateId: "hello-world" })),
    ).toBe(true);
  });

  it("requires a clone source", () => {
    expect(ids(unmetRequirements(input({ path: "clone" })))).toEqual(["source"]);
    expect(
      canCreateWorkflow(input({ path: "clone", cloneSlug: "raas-default" })),
    ).toBe(true);
  });

  it("does not impose generate-path requirements on other paths", () => {
    for (const path of ["blank", "template", "clone", "import"] as const) {
      const listed = ids(newWorkflowRequirements(input({ path })));
      expect(listed).not.toContain("purpose");
      expect(listed).not.toContain("generated");
    }
  });
});
