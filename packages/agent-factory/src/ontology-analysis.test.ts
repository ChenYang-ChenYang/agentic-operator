import { describe, expect, it } from "vitest";
import type { DomainOntology } from "./ontology-types";
import {
  analyzeOntologyStructure,
  renderAnalysisForModel,
} from "./ontology-analysis";

function ontology(overrides: Partial<DomainOntology> = {}): DomainOntology {
  return {
    domainId: "Agents-generation",
    source: "allmeta",
    objects: [
      { id: "Job_Requisition", name: "Job_Requisition" },
      { id: "Job_Posting", name: "Job_Posting" },
      { id: "Employee", name: "Employee" },
      { id: "Orphan_Object", name: "Orphan_Object" },
    ],
    rules: [],
    events: [
      { name: "requisition.approved" },
      { name: "jd.generated" },
      { name: "never.used" },
    ],
    actions: [
      {
        id: "1",
        name: "createJD",
        actor: ["Agent"],
        trigger: ["requisition.approved"],
        triggered_event: ["jd.generated"],
        target_objects: ["Job_Requisition", "Job_Posting"],
        tool_use: [],
        system_prompt: "",
        user_prompt: "",
        integration: { systems: ["RAAS_System", "GoHire_System"] },
      },
      {
        id: "2",
        name: "reviewJD",
        actor: ["Human"],
        trigger: ["jd.generated"],
        triggered_event: [],
        target_objects: [],
        tool_use: [],
        system_prompt: "",
        user_prompt: "",
      },
    ],
    links: [
      {
        id: "object-fk/Job_Posting/Job_Requisition",
        kind: "object-fk",
        from: { id: "Job_Posting", type: "DataObject" },
        to: { id: "Job_Requisition", type: "DataObject" },
      },
      {
        id: "object-fk/Job_Requisition/Employee",
        kind: "object-fk",
        from: { id: "Job_Requisition", type: "DataObject" },
        to: { id: "Employee", type: "DataObject" },
      },
      {
        id: "rule-binding/createJD/R-1",
        kind: "rule-binding",
        from: { id: "createJD", type: "Action" },
        to: { id: "R-1", type: "Rule" },
      },
    ],
    workflow: [],
    ...overrides,
  } as DomainOntology;
}

describe("analyzeOntologyStructure", () => {
  it("reads the real relationship graph instead of a bare count", () => {
    const a = analyzeOntologyStructure(ontology());
    expect(a.hasLinkGraph).toBe(true);
    expect(a.counts.links).toBe(3);
    const kinds = a.relationshipKinds.map((k) => k.kind);
    expect(kinds).toContain("object-fk");
    expect(kinds).toContain("rule-binding");
    const fk = a.relationshipKinds.find((k) => k.kind === "object-fk");
    expect(fk?.count).toBe(2);
    // examples make each claim checkable
    expect(fk?.examples[0]).toMatchObject({ from: "Job_Posting" });
  });

  it("profiles entity connectivity and flags genuinely isolated objects", () => {
    const a = analyzeOntologyStructure(ontology());
    const req = a.entities.find((e) => e.id === "Job_Requisition");
    expect(req?.inbound).toBe(1);
    expect(req?.outbound).toBe(1);
    expect(req?.touchedByActions).toContain("createJD");
    expect(a.isolatedEntities).toContain("Orphan_Object");
    // hubs are ordered by degree and exclude zero-degree objects
    expect(a.hubs.some((h) => h.id === "Orphan_Object")).toBe(false);
  });

  it("derives event chains with entry and terminal events", () => {
    const a = analyzeOntologyStructure(ontology());
    expect(a.entryEvents).toContain("requisition.approved");
    const chain = a.eventChains.find(
      (c) => c.entryEvent === "requisition.approved",
    );
    expect(chain?.path).toEqual(["createJD", "reviewJD"]);
    expect(chain?.cyclic).toBe(false);
  });

  it("does not present a cycle as a clean pipeline", () => {
    const cyclic = ontology({
      actions: [
        {
          id: "1",
          name: "a",
          actor: ["Agent"],
          trigger: ["start"],
          triggered_event: ["loop"],
          target_objects: [],
          tool_use: [],
          system_prompt: "",
          user_prompt: "",
        },
        {
          id: "2",
          name: "b",
          actor: ["Agent"],
          trigger: ["loop"],
          triggered_event: ["start"],
          target_objects: [],
          tool_use: [],
          system_prompt: "",
          user_prompt: "",
        },
      ],
    } as unknown as Partial<DomainOntology>);
    const a = analyzeOntologyStructure(cyclic);
    const chain = a.eventChains[0];
    if (chain) expect(chain.cyclic).toBe(true);
  });

  it("separates agent from human actions and collects external systems", () => {
    const a = analyzeOntologyStructure(ontology());
    expect(a.agentActions).toEqual(["createJD"]);
    expect(a.humanActions).toEqual(["reviewJD"]);
    expect(a.externalSystems).toEqual(["GoHire_System", "RAAS_System"]);
  });

  it("reads Allmeta's rich integration.systems objects, not just bare strings", () => {
    // Live Allmeta emits {name, kind, role, capability}; reading only strings
    // silently reported "no external systems" for every real domain.
    const rich = ontology({
      actions: [
        {
          id: "1",
          name: "processResume",
          actor: ["Agent"],
          trigger: ["RESUME_DOWNLOADED"],
          triggered_event: ["RESUME_PROCESSED"],
          target_objects: ["Resume"],
          tool_use: [],
          system_prompt: "",
          user_prompt: "",
          integration: {
            systems: [
              { call_order: 1, name: "Object_Storage_System", role: "read" },
              { call_order: 2, name: "GoHire_System", role: "write" },
              "Legacy_String_System",
            ],
          },
        },
      ],
    } as unknown as Partial<DomainOntology>);
    const a = analyzeOntologyStructure(rich);
    expect(a.externalSystems).toEqual([
      "GoHire_System",
      "Legacy_String_System",
      "Object_Storage_System",
    ]);
  });

  it("still finds flows when every event is also emitted (no strict entry)", () => {
    // Mature domains are often closed graphs; a naive walker reports "no flows"
    // for a graph that is full of them.
    const closed = ontology({
      events: [{ name: "a.done" }, { name: "b.done" }],
      actions: [
        {
          id: "1",
          name: "stepA",
          actor: ["Agent"],
          trigger: ["b.done"],
          triggered_event: ["a.done"],
          target_objects: ["Job_Requisition"],
          tool_use: [],
          system_prompt: "",
          user_prompt: "",
        },
        {
          id: "2",
          name: "stepB",
          actor: ["Agent"],
          trigger: ["a.done"],
          triggered_event: ["b.done"],
          target_objects: ["Job_Posting"],
          tool_use: [],
          system_prompt: "",
          user_prompt: "",
        },
      ],
    } as unknown as Partial<DomainOntology>);
    const a = analyzeOntologyStructure(closed);
    expect(a.entryEvents).toEqual([]);
    expect(a.eventChains.length).toBeGreaterThan(0);
    expect(a.eventChains[0]?.path.length).toBeGreaterThan(0);
    expect(a.eventChains[0]?.cyclic).toBe(true);
  });

  it("reports checkable structural gaps", () => {
    const a = analyzeOntologyStructure(ontology());
    const kinds = a.gaps.map((g) => g.kind);
    expect(kinds).toContain("actions_without_objects");
    expect(kinds).toContain("unreferenced_events");
    expect(kinds).toContain("isolated_entities");
    const unused = a.gaps.find((g) => g.kind === "unreferenced_events");
    expect(unused?.subjects).toContain("never.used");
  });

  it("is honest when the source supplied no link graph", () => {
    const a = analyzeOntologyStructure(ontology({ links: undefined }));
    expect(a.hasLinkGraph).toBe(false);
    expect(a.gaps.map((g) => g.kind)).toContain("no_link_graph");
    expect(a.relationshipKinds).toEqual([]);
  });
});

describe("renderAnalysisForModel", () => {
  it("renders real edges, chains and gaps compactly", () => {
    const text = renderAnalysisForModel(analyzeOntologyStructure(ontology()));
    expect(text).toContain("object-fk ×2");
    expect(text).toContain("Job_Posting→Job_Requisition");
    expect(text).toContain("requisition.approved → createJD → reviewJD");
    expect(text).toContain("GoHire_System");
    expect(text).toContain("unreferenced_events");
  });
});
