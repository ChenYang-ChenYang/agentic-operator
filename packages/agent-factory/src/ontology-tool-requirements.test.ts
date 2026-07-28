import { describe, expect, it } from "vitest";
import {
  analyzeToolRequirements,
  renderToolRequirementsForModel,
} from "./ontology-tool-requirements";
import type { DomainOntology } from "./ontology-types";
import type { RealTool } from "./tool-catalog";

/** Shape mirrors what the live source serves: `action.integration.systems[]`. */
function actionWith(name: string, systems: unknown[]): Record<string, unknown> {
  return {
    id: `act-${name}`,
    name,
    description: name,
    executor: "Agent",
    trigger: [],
    emits: [],
    target_objects: [],
    integration: { systems },
  };
}

function ontologyOf(actions: unknown[]): DomainOntology {
  return {
    domainId: "T",
    objects: [],
    actions: actions as DomainOntology["actions"],
    events: [],
    rules: [],
    links: [],
  } as unknown as DomainOntology;
}

const OBJECT_STORE_TOOL: RealTool = {
  name: "objectStore.getObject",
  summary: "read an object",
  capabilities: [
    {
      systems: ["Object_Storage_System"],
      kinds: ["object_storage"],
      roles: ["read"],
      objectTypes: ["Resume_Upload"],
    },
  ],
} as RealTool;

describe("analyzeToolRequirements", () => {
  it("reports a human_ui requirement as an authored human step, never a tool gap", () => {
    // The bug this locks down: the binding engine has no notion of human_ui, so
    // an Ontology-authored manual step was reported as "no tool covers this" —
    // eleven of them on the live domain. An FDE reading that would go build
    // eleven tools that must not exist.
    const analysis = analyzeToolRequirements(
      ontologyOf([
        actionWith("jdReview", [
          {
            name: "RAAS_System",
            kind: "human_ui",
            role: "execute",
            capability: "jd.review",
            objects: ["Job_Posting"],
          },
        ]),
      ]),
      [],
    );

    expect(analysis.total).toBe(1);
    expect(analysis.humanSteps).toBe(1);
    expect(analysis.gaps).toBe(0);
    expect(analysis.gapSystems).toEqual([]);
    expect(analysis.rows[0]!.verdict).toBe("human_step");
    expect(analysis.rows[0]!.tools).toEqual([]);
  });

  it("names the real tool when exactly one declares coverage", () => {
    const analysis = analyzeToolRequirements(
      ontologyOf([
        actionWith("processResume", [
          {
            name: "Object_Storage_System",
            kind: "object_storage",
            role: "read",
            capability: "resume.download",
            objects: ["Resume_Upload"],
          },
        ]),
      ]),
      [OBJECT_STORE_TOOL],
    );

    expect(analysis.gaps).toBe(0);
    expect(analysis.rows[0]!.tools).toEqual(["objectStore.getObject"]);
    expect(analysis.catalogSize).toBe(1);
  });

  it("reports a genuine gap with the system that needs a new tool", () => {
    const analysis = analyzeToolRequirements(
      ontologyOf([
        actionWith("processResume", [
          {
            name: "Internal_Recruitment_System",
            kind: "external_api",
            role: "execute",
            capability: "candidate.lock_check",
            objects: ["Candidate"],
          },
        ]),
      ]),
      [OBJECT_STORE_TOOL],
    );

    expect(analysis.gaps).toBe(1);
    expect(analysis.gapSystems).toEqual(["Internal_Recruitment_System"]);
    expect(analysis.rows[0]!.verdict).toBe("gap");
    expect(analysis.rows[0]!.reason).toContain("Internal_Recruitment_System");
  });

  it("does not pick a winner when two tools tie — the FDE decides", () => {
    const twin: RealTool = {
      ...OBJECT_STORE_TOOL,
      name: "fs.readFromInbox",
    } as RealTool;
    const analysis = analyzeToolRequirements(
      ontologyOf([
        actionWith("processResume", [
          {
            name: "Object_Storage_System",
            kind: "object_storage",
            role: "read",
            capability: "resume.download",
            objects: ["Resume_Upload"],
          },
        ]),
      ]),
      [OBJECT_STORE_TOOL, twin],
    );

    expect(analysis.ambiguous).toBe(1);
    expect(analysis.gaps).toBe(0);
    expect(analysis.rows[0]!.tools).toEqual([
      "fs.readFromInbox",
      "objectStore.getObject",
    ]);
  });

  it("an empty catalogue yields gaps, and the rendering says how small the catalogue was", () => {
    // "We could not look" must never render as "nothing is missing"; the reader
    // needs the catalogue size to tell the two apart.
    const analysis = analyzeToolRequirements(
      ontologyOf([
        actionWith("processResume", [
          {
            name: "Object_Storage_System",
            kind: "object_storage",
            role: "read",
            capability: "resume.download",
            objects: ["Resume_Upload"],
          },
        ]),
      ]),
      [],
    );

    expect(analysis.gaps).toBe(1);
    expect(renderToolRequirementsForModel(analysis)).toContain("工具库 0 个");
  });

  it("self-reports truncation instead of presenting a partial list as the whole", () => {
    const actions = Array.from({ length: 5 }, (_, i) =>
      actionWith(`a${i}`, [
        {
          system: `Sys_${i}`,
          kind: "external_api",
          role: "execute",
          capability: `cap.${i}`,
          objects: ["X"],
        },
      ]),
    );
    const rendered = renderToolRequirementsForModel(
      analyzeToolRequirements(ontologyOf(actions), []),
      { maxRows: 2 },
    );
    expect(rendered).toContain("共 5 条");
    expect(rendered).toContain("前 2 条");
  });

  it("returns nothing for an ontology that declares no integrations at all", () => {
    const analysis = analyzeToolRequirements(ontologyOf([actionWith("noop", [])]), []);
    expect(analysis.total).toBe(0);
    expect(renderToolRequirementsForModel(analysis)).toBe("");
  });
});
