/**
 * The downloadable annotated manifest must survive the exact trip a person
 * takes with it: download → edit in a text editor → drop back onto Import.
 *
 * Two of these assertions guard traps that fail LATE and loudly rather than at
 * import time: an annotation inside a port `schema` throws in Ajv strict mode
 * at run time, and an annotation key ending `_env`/`_ref`/`_secret_name` is
 * rejected by the workflow secret scanner on every create/save/validate.
 */

import { describe, expect, it } from "vitest";
import { normalizeWorkflowManifest } from "@agentic/contracts";
import {
  WORKFLOW_TEMPLATE_FILENAME,
  WORKFLOW_TEMPLATE_UNANNOTATABLE_KEYS,
  annotateWorkflowManifest,
  blankTemplateForDownload,
} from "../src/services/workflow-template-doc";
import { instantiateBlankWorkflow } from "../src/services/workflow-templates";
import { validateWorkflowManifest } from "../src/services/workflow-authoring";
import { findWorkflowSecretPolicyIssues } from "../src/services/workflow-secret-policy";

const SECRET_REFERENCE_SUFFIX = /(_env|_ref|_secret_name)$/i;

function walk(
  value: unknown,
  visit: (key: string, value: unknown, path: string[]) => void,
  path: string[] = [],
): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => walk(item, visit, [...path, String(index)]));
    return;
  }
  if (typeof value !== "object" || value === null) return;
  for (const [key, child] of Object.entries(value)) {
    visit(key, child, path);
    walk(child, visit, [...path, key]);
  }
}

describe("downloadable annotated workflow template", () => {
  const template = blankTemplateForDownload();

  it("is plain JSON that survives a byte-for-byte round trip", () => {
    const serialized = JSON.stringify(template, null, 2);
    // The whole point of not shipping JSONC: every ingest path is a strict
    // JSON.parse, so the bytes we hand the user must parse unchanged.
    expect(() => JSON.parse(serialized)).not.toThrow();
    expect(JSON.parse(serialized)).toEqual(template);
    // No line may BEGIN a JSONC-style comment. ("//" inside a string value is
    // fine and expected — one of the rules tells the reader not to add them.)
    const commentLines = serialized
      .split("\n")
      .filter((line) => /^\s*(\/\/|\/\*)/.test(line));
    expect(commentLines).toEqual([]);
  });

  it("carries readable guidance a newcomer can act on", () => {
    expect(Array.isArray(template._readme)).toBe(true);
    expect(Array.isArray(template._rules)).toBe(true);
    const agents = template.agents as Array<Record<string, unknown>>;
    expect(agents).toHaveLength(1);
    expect(Array.isArray(agents[0]!._doc)).toBe(true);
    // The system prompt is the field the whole demo turns on, so it must be
    // named as such in the guidance rather than left as jargon.
    expect(JSON.stringify(agents[0]!._doc)).toContain("SYSTEM PROMPT");
    expect(template._example_second_agent).toBeTruthy();
  });

  it("re-imports and validates with the annotations still attached", () => {
    const normalized = normalizeWorkflowManifest(template);
    const validation = validateWorkflowManifest(normalized, {
      tenantSlug: "template-download",
    });
    expect(
      validation.issues.filter((issue) => issue.severity === "error"),
    ).toEqual([]);
    expect(validation.valid).toBe(true);
    // Proves the `.passthrough()` round trip: the guidance is still there after
    // the manifest has been through the schema.
    const agent = normalized.agents[0] as unknown as Record<string, unknown>;
    expect(Array.isArray(agent._doc)).toBe(true);
  });

  it("never writes an annotation inside a strictly validated subtree", () => {
    const offenders: string[] = [];
    walk(template, (key, value, path) => {
      if (!key.startsWith("_")) return;
      const inStrictSubtree = path.some((segment) =>
        WORKFLOW_TEMPLATE_UNANNOTATABLE_KEYS.has(segment),
      );
      if (inStrictSubtree) offenders.push([...path, key].join("."));
      void value;
    });
    expect(offenders).toEqual([]);
  });

  it("cannot trip the workflow secret scanner", () => {
    const suffixOffenders: string[] = [];
    walk(template, (key, _value, path) => {
      if (SECRET_REFERENCE_SUFFIX.test(key)) {
        suffixOffenders.push([...path, key].join("."));
      }
    });
    expect(suffixOffenders).toEqual([]);
    expect(
      findWorkflowSecretPolicyIssues(
        normalizeWorkflowManifest(template),
        undefined,
        { tenantSlug: "template-download" },
      ),
    ).toEqual([]);
  });

  it("is portable: no workspace-specific provider or model is baked in", () => {
    for (const agent of template.agents as Array<Record<string, unknown>>) {
      expect(agent.provider).toBeUndefined();
      expect(agent.model).toBeUndefined();
    }
  });

  it("teaches no action-level retries, which the runtime forbids", () => {
    const agents = [
      ...(template.agents as Array<Record<string, unknown>>),
      template._example_second_agent as Record<string, unknown>,
    ];
    for (const agent of agents) {
      for (const action of (agent.actions ?? []) as Array<
        Record<string, unknown>
      >) {
        expect("retries" in action).toBe(false);
      }
    }
  });

  it("chains the example second agent onto the first agent's emitted event", () => {
    const first = (template.agents as Array<Record<string, unknown>>)[0]!;
    const second = template._example_second_agent as Record<string, unknown>;
    expect(second.trigger).toEqual([
      (first.triggered_event as string[])[0],
    ]);
  });

  it("annotates a catalog template as well as the blank starter", () => {
    const annotated = annotateWorkflowManifest(
      instantiateBlankWorkflow({ slug: "other" }),
    );
    expect(Array.isArray(annotated._readme)).toBe(true);
  });

  it("uses a filename the importer routes to the workflow slot", () => {
    expect(WORKFLOW_TEMPLATE_FILENAME).toMatch(/workflow.*\.json$/i);
    // handleFiles tests /actions.*\.json$/i FIRST, so the name must not match.
    expect(WORKFLOW_TEMPLATE_FILENAME).not.toMatch(/actions.*\.json$/i);
  });
});
