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

// #RULES —— 规则以前只是 counts 里的一个整数。这一组锁住的是「读出来的东西必须诚实」：
// 未声明不等于不严重、接不上动作要报出来、政策不是全域统一的。
describe("rule analysis", () => {
  const rule = (over: Record<string, unknown> = {}) => ({
    id: "1-1", businessLogicRuleName: "R1", enforcementLevel: "mandatory",
    failurePolicy: "block", executor: "Agent", automationStatus: "approved",
    applicableClient: "通用", specificScenarioStage: "简历处理", relatedEntities: ["Job_Requisition"],
    ...over,
  });
  const withRules = (rules: Array<Record<string, unknown>>, actionOver: Record<string, unknown> = {}) =>
    analyzeOntologyStructure(ontology({
      rules,
      actions: [{
        id: "1", name: "createJD", actor: ["Agent"], trigger: ["requisition.approved"],
        triggered_event: ["jd.generated"], target_objects: ["Job_Requisition"], tool_use: [],
        system_prompt: "", user_prompt: "", ...actionOver,
      }],
    } as unknown as Partial<DomainOntology>));

  it("never turns an undeclared enforcement into a harmless warning", () => {
    const a = withRules([
      rule({ id: "ok-1" }),
      // 本体没说 → 就是没说。兜底成 warn 会把一批本该由人裁决的约束标成无害。
      rule({ id: "quiet-1", enforcementLevel: null, failurePolicy: null, relatedEntities: [] }),
    ]);
    const quiet = a.rules.rules.find((r) => r.id === "quiet-1");
    expect(quiet?.failurePolicy).toBeNull();
    expect(quiet?.enforcementLevel).toBeNull();
    expect(a.rules.warning).toBe(0);
    expect(a.rules.undeclared).toBe(1);
    expect(a.gaps.map((g) => g.kind)).toContain("rules_without_enforcement");
    expect(a.gaps.find((g) => g.kind === "rules_without_enforcement")?.detail).toContain("未声明 ≠ 不严重".slice(0, 3));
  });

  it("reports the rules the generator can never see", () => {
    const a = withRules(
      [rule({ id: "wired" }), rule({ id: "orphan" })],
      { action_steps: [{ name: "check", rules: [{ id: "wired" }] }] },
    );
    expect(a.rules.reachableFromActions).toBe(1);
    expect(a.rules.orphans).toEqual(["orphan"]);
    const gap = a.gaps.find((g) => g.kind === "rules_without_actions");
    // 这条 gap 的类型早就声明了，却从来没被构造过——孤儿规则从未报给任何人。
    expect(gap?.subjects).toContain("orphan");
  });

  it("flags one action carrying rules from mutually exclusive clients", () => {
    const a = withRules(
      [
        rule({ id: "a-1", applicableClient: "腾讯" }),
        rule({ id: "b-1", applicableClient: "字节" }),
      ],
      { action_steps: [{ name: "check", rules: [{ id: "a-1" }, { id: "b-1" }] }] },
    );
    expect(a.rules.crossClientActions).toEqual([
      { action: "createJD", clients: ["字节", "腾讯"], blockingRules: 2 },
    ]);
    expect(a.gaps.map((g) => g.kind)).toContain("rules_span_multiple_clients");
    // 「通用」不算冲突：它本来就适用于所有客户。
    const shared = withRules(
      [rule({ id: "a-1", applicableClient: "腾讯" }), rule({ id: "u-1", applicableClient: "通用" })],
      { action_steps: [{ name: "check", rules: [{ id: "a-1" }, { id: "u-1" }] }] },
    );
    expect(shared.rules.crossClientActions).toEqual([]);
  });

  it("keeps same-named rules apart and reports the collision", () => {
    const a = withRules([
      rule({ id: "28-3", businessLogicRuleName: "Offer发放双系统校验", applicableDepartment: "IEG" }),
      rule({ id: "28-4", businessLogicRuleName: "Offer发放双系统校验", applicableDepartment: "CDG" }),
    ]);
    expect(a.rules.total).toBe(2);
    expect(a.rules.duplicateNames).toEqual([
      { name: "Offer发放双系统校验", ids: ["28-3", "28-4"] },
    ]);
  });

  it("separates entities a rule really governs from references that resolve to nothing", () => {
    const a = withRules([rule({ id: "r", relatedEntities: ["Job_Requisition", "Ghost_Object"] })]);
    const r = a.rules.rules[0]!;
    expect(r.governs).toEqual(["Job_Requisition"]);
    expect(r.danglingGoverns).toEqual(["Ghost_Object"]);
  });

  it("says so when it truncates, instead of implying full coverage", () => {
    const many = Array.from({ length: 40 }, (_, i) => rule({ id: `r-${i}`, businessLogicRuleName: `R${i}` }));
    const a = withRules(many, {
      action_steps: [{ name: "check", rules: many.map((r) => ({ id: r.id })) }],
    });
    const text = renderAnalysisForModel(a, { maxRules: 5 });
    expect(text).toContain("共 40 条，下列为前 5 条");
  });
});
