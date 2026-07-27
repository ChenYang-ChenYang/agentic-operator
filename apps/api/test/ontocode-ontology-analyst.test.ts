import { describe, expect, it } from "vitest";
import type { DomainOntology } from "@agentic/agent-factory";
import { analyzeOntology } from "../src/services/ontocode-ontology-analyst";

function ontology(overrides: Partial<DomainOntology> = {}): DomainOntology {
  return {
    domainId: "Agents-generation",
    source: "allmeta",
    objects: [
      { id: "Job_Requisition" },
      { id: "Job_Posting" },
      { id: "Employee" },
    ],
    rules: [],
    events: [{ name: "requisition.approved" }, { name: "jd.generated" }],
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
      },
    ],
    links: [
      {
        id: "object-fk/Job_Posting/Job_Requisition",
        kind: "object-fk",
        from: { id: "Job_Posting", type: "DataObject" },
        to: { id: "Job_Requisition", type: "DataObject" },
      },
    ],
    workflow: [],
    ...overrides,
  } as DomainOntology;
}

describe("analyzeOntology", () => {
  it("produces a full structural reading with no gateway and says so", async () => {
    const receipt = await analyzeOntology(ontology(), {
      gatewayConfigured: () => false,
    });
    expect(receipt.schema).toBe("ontocode-ontology-analysis/v1");
    // the structural half never depends on a model
    expect(receipt.structure.counts.links).toBe(1);
    expect(receipt.structure.relationshipKinds[0]?.kind).toBe("object-fk");
    expect(receipt.substrate.relationshipGraph).toBe("available");
    expect(receipt.substrate.interpretation).toBe("not_configured");
    expect(receipt.findings).toEqual([]);
    expect(receipt.limitations.join()).toContain("未配置 LLM 网关");
  });

  it("confirms findings whose citations exist and downgrades invented ones", async () => {
    const receipt = await analyzeOntology(ontology(), {
      gatewayConfigured: () => true,
      interpret: async () => ({
        findings: [
          {
            claim: "岗位发布依赖需求单",
            refs: ["Job_Posting", "Job_Requisition"],
          },
          { claim: "存在薪酬审批系统", refs: ["Payroll_Approval_System"] },
          { claim: "没有引用任何 id 的断言", refs: [] },
        ],
        narrative: "该域围绕需求单到岗位发布展开。",
      }),
    });
    const confirmed = receipt.findings.filter(
      (f) => f.verdict === "confirmed",
    );
    expect(confirmed).toHaveLength(1);
    expect(confirmed[0]?.claim).toContain("岗位发布依赖需求单");

    const invented = receipt.findings.find((f) =>
      f.claim.includes("薪酬审批"),
    );
    // an id the ontology never had cannot be published as fact
    expect(invented?.verdict).toBe("unverifiable");
    expect(invented?.unknownRefs).toContain("Payroll_Approval_System");

    const unsourced = receipt.findings.find((f) => f.refs.length === 0);
    expect(unsourced?.verdict).toBe("unverifiable");
    expect(receipt.narrative).toContain("需求单");
    expect(receipt.limitations.join()).toContain("未经验证");
  });

  it("distinguishes 'could not look' from 'looked and found nothing'", async () => {
    const noSource = await analyzeOntology(ontology(), {
      gatewayConfigured: () => false,
    });
    expect(noSource.substrate.instances).toBe("unsupported_by_source");
    expect(noSource.limitations.join()).toContain("不提供实例读取");

    const emptyGraph = await analyzeOntology(ontology(), {
      gatewayConfigured: () => false,
      listInstances: async () => ({ items: [] }),
    });
    expect(emptyGraph.substrate.instances).toBe("empty");
    expect(emptyGraph.limitations.join()).toContain("0 行");
  });

  it("records live probes, including failures, without aborting", async () => {
    const receipt = await analyzeOntology(ontology(), {
      gatewayConfigured: () => false,
      fetchActionRules: async (_d, name) => {
        if (name === "createJD") throw new Error("allmeta 429");
        return [];
      },
      listInstances: async () => ({ items: [{ id: "row-1" }] }),
    });
    const ruleProbe = receipt.probes.find((p) => p.probe === "action_rules");
    expect(ruleProbe?.ok).toBe(false);
    expect(ruleProbe?.detail).toContain("429");
    // a failed probe must not sink the whole analysis
    expect(receipt.structure.counts.objects).toBe(3);
    expect(receipt.substrate.instances).toBe("available");
  });

  it("is honest when the source carries no relationship graph", async () => {
    const receipt = await analyzeOntology(ontology({ links: undefined }), {
      gatewayConfigured: () => false,
    });
    expect(receipt.substrate.relationshipGraph).toBe("empty");
    expect(receipt.limitations.join()).toContain("没有提供已编译的关系图");
  });

  it("survives a failing interpretation and keeps the structural half", async () => {
    const receipt = await analyzeOntology(ontology(), {
      gatewayConfigured: () => true,
      interpret: async () => {
        throw new Error("gateway 503");
      },
    });
    expect(receipt.substrate.interpretation).toBe("empty");
    expect(receipt.limitations.join()).toContain("503");
    expect(receipt.structure.counts.links).toBe(1);
  });
});
