/**
 * Why the Create button is disabled.
 *
 * The modal previously computed one boolean and disabled the button, leaving
 * the operator to guess which of four unrelated conditions was unmet — and on
 * the AI path the answer ("you have to press Generate first, and your last
 * generation is stale") is not something anyone would infer from a greyed-out
 * button.
 *
 * Kept pure and separate from the component so the rules are testable and can
 * be read in one screen.
 */

export type CreationPathId =
  | "generate"
  | "blank"
  | "template"
  | "clone"
  | "import";

export interface RequirementInput {
  path: CreationPathId;
  name: string;
  slug: string;
  purpose: string;
  hasPreview: boolean;
  previewIsCurrent: boolean;
  templateId: string;
  cloneSlug: string;
}

export interface Requirement {
  /** Stable id; the i18n key is `newWorkflowModal.req_<id>`. */
  id: string;
  met: boolean;
}

/** Minimum characters the generator needs before it will accept a purpose. */
export const MIN_PURPOSE_CHARS = 20;

/**
 * Every requirement for the CURRENT path, in the order the eye should travel:
 * identity first, then whatever the chosen path adds.
 */
export function newWorkflowRequirements(
  input: RequirementInput,
): Requirement[] {
  const requirements: Requirement[] = [
    { id: "displayName", met: input.name.trim().length > 0 },
    { id: "slug", met: input.slug.trim().length > 0 },
  ];

  if (input.path === "generate") {
    requirements.push({
      id: "purpose",
      met: input.purpose.trim().length >= MIN_PURPOSE_CHARS,
    });
    requirements.push({ id: "generated", met: input.hasPreview });
    // Only worth showing once a preview exists: before that, "regenerate" is
    // noise on top of "generate".
    if (input.hasPreview) {
      requirements.push({ id: "previewCurrent", met: input.previewIsCurrent });
    }
  }

  if (input.path === "template") {
    requirements.push({ id: "template", met: input.templateId.trim().length > 0 });
  }

  if (input.path === "clone") {
    requirements.push({ id: "source", met: input.cloneSlug.trim().length > 0 });
  }

  return requirements;
}

/** The requirements still blocking Create. Empty means the button is live. */
export function unmetRequirements(input: RequirementInput): Requirement[] {
  return newWorkflowRequirements(input).filter(
    (requirement) => !requirement.met,
  );
}

export function canCreateWorkflow(input: RequirementInput): boolean {
  return unmetRequirements(input).length === 0;
}
