import { afterEach, describe, expect, it, vi } from "vitest";
import type { DomainOntology } from "@agentic/agent-factory";
import { OntoCodeAnalystPresentationV1Schema } from "@agentic/contracts";
import { analyzeOntology } from "../src/services/ontocode-ontology-analyst";
import { _setLLMGatewayForTests } from "../src/services/llm";

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
  afterEach(() => {
    _setLLMGatewayForTests(null);
    vi.restoreAllMocks();
  });

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
    expect(receipt.presentation.schema).toBe(
      "ontocode-analysis-presentation/v1",
    );
    expect(
      OntoCodeAnalystPresentationV1Schema.safeParse(receipt.presentation)
        .success,
    ).toBe(true);
    expect(receipt.presentation.blocks.map((block) => block.kind)).toEqual(
      expect.arrayContaining(["metrics", "table", "relationship", "list"]),
    );
    expect(
      receipt.presentation.blocks.find(
        (block) => block.id === "ontology-objects",
      ),
    ).toMatchObject({ kind: "table", totalRows: 3, truncated: false });
    expect(
      receipt.presentation.blocks.find(
        (block) => block.id === "ontology-relationships",
      ),
    ).toMatchObject({ kind: "relationship", totalEdges: 1 });
  });

  it("emits contract-valid bounded tag cells for large Ontology arrays", async () => {
    const receipt = await analyzeOntology(
      ontology({
        actions: [
          {
            ...ontology().actions[0]!,
            actor: Array.from({ length: 30 }, (_value, index) => {
              return `Actor-${index}`;
            }),
          },
        ],
      }),
      { gatewayConfigured: () => false },
    );

    expect(
      OntoCodeAnalystPresentationV1Schema.safeParse(receipt.presentation)
        .success,
    ).toBe(true);
    const actionBlock = receipt.presentation.blocks.find(
      (block) => block.id === "ontology-actions",
    );
    expect(actionBlock?.kind).toBe("table");
    if (actionBlock?.kind !== "table") {
      throw new Error("expected ontology-actions table");
    }
    expect(actionBlock.rows[0]?.actor).toHaveLength(8);
  });

  it("validates citation ids without presenting model claims as confirmed facts", async () => {
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
    const citationValid = receipt.findings.filter(
      (finding) => finding.verdict === "citation_valid",
    );
    expect(citationValid).toHaveLength(1);
    expect(citationValid[0]?.claim).toContain("岗位发布依赖需求单");

    const invented = receipt.findings.find((f) => f.claim.includes("薪酬审批"));
    // an id the ontology never had cannot be published as fact
    expect(invented?.verdict).toBe("unverifiable");
    expect(invented?.unknownRefs).toContain("Payroll_Approval_System");

    const unsourced = receipt.findings.find((f) => f.refs.length === 0);
    expect(unsourced?.verdict).toBe("unverifiable");
    expect(receipt.narrative).toContain("需求单");
    expect(receipt.limitations.join()).toContain("不存在的 id");
    expect(receipt.limitations.join()).toContain("不代表解释语义");
    const findingsBlock = receipt.presentation.blocks.find(
      (block) => block.id === "analyst-findings",
    );
    expect(findingsBlock).toMatchObject({
      kind: "list",
      title: "模型解释与引用状态",
    });
    expect(JSON.stringify(findingsBlock)).not.toContain("已核验结论");
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

    const unreachable = await analyzeOntology(ontology(), {
      gatewayConfigured: () => false,
      listInstances: async () => {
        throw new Error("Allmeta unavailable");
      },
    });
    expect(unreachable.substrate.instances).toBe("unsupported_by_source");
    expect(unreachable.limitations.join()).toContain("不表示数据为 0 行");
  });

  it("uses the FDE question as an interpretation focus and a view hint only", async () => {
    let modelMaterial = "";
    const receipt = await analyzeOntology(ontology(), {
      question: "哪些规则会阻断 createJD？",
      focus: ["规则", "外部系统"],
      presentation: ["relationship", "table"],
      gatewayConfigured: () => true,
      interpret: async (_system, material) => {
        modelMaterial = material;
        return { findings: [], narrative: "未发现可核验的阻断规则。" };
      },
    });

    expect(modelMaterial).toContain("哪些规则会阻断 createJD");
    expect(receipt.request).toEqual({
      question: "哪些规则会阻断 createJD?",
      focus: ["规则", "外部系统"],
      preferredViews: ["relationship", "table"],
    });
    expect(receipt.presentation.title).toContain("哪些规则会阻断 createJD");
    // Metrics remain the orientation header; requested visual kinds are then
    // prioritised without hiding any evidence blocks.
    expect(
      receipt.presentation.blocks.slice(0, 3).map((block) => block.kind),
    ).toEqual(["metrics", "metrics", "relationship"]);
    expect(receipt.structure.counts.objects).toBe(3);
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

  it("persists only bounded and recursively redacted instance samples", async () => {
    const longText = "x".repeat(800);
    let modelMaterial = "";
    const receipt = await analyzeOntology(ontology(), {
      gatewayConfigured: () => true,
      interpret: async (_system, material) => {
        modelMaterial = material;
        return {
          findings: [
            {
              claim: "抽样行处于 active 状态",
              refs: ["sample:job_requisition:1"],
            },
          ],
          narrative: "结论只覆盖脱敏后的有界样本。",
        };
      },
      listInstances: async (_domain, objectType) => ({
        items: Array.from({ length: 8 }, (_, index) => ({
          id: `${objectType}-${index}`,
          email: `person-${index}@example.test`,
          mobile_phone: "13000000000",
          public_status: "active",
          public_note: "Contact hidden@example.test or 13912345678",
          numeric_contact: 13912345678,
          operator_note: "password=classified",
          profile: {
            displayName: "可见名称",
            api_key: "must-never-persist",
            nested: { password: "also-secret", note: longText },
          },
          description: longText,
          ...Object.fromEntries(
            Array.from({ length: 20 }, (_value, column) => [
              `extra_${column}`,
              column,
            ]),
          ),
        })),
      }),
    });

    const sample = receipt.instanceSamples[0]!;
    expect(sample.observedRows).toBe(8);
    expect(sample.shownRows).toBe(5);
    expect(sample.columns.length).toBeLessThanOrEqual(12);
    expect(sample.rowRefs[0]).toBe("sample:job_requisition:1");
    expect(sample.truncated).toBe(true);
    expect(sample.rows[0]?.email).toBe("[REDACTED]");
    expect(sample.rows[0]?.mobile_phone).toBe("[REDACTED]");
    expect(sample.rows[0]?.public_note).toBe("[REDACTED]");
    expect(sample.rows[0]?.numeric_contact).toBe("[REDACTED]");
    expect(sample.rows[0]?.operator_note).toBe("[REDACTED]");
    expect(String(sample.rows[0]?.profile)).toContain("[REDACTED]");
    expect(String(sample.rows[0]?.profile)).not.toContain("must-never-persist");
    expect(String(sample.rows[0]?.description).length).toBeLessThanOrEqual(320);

    const serialized = JSON.stringify(receipt);
    expect(serialized).not.toContain("person-0@example.test");
    expect(serialized).not.toContain("hidden@example.test");
    expect(serialized).not.toContain("13912345678");
    expect(serialized).not.toContain("classified");
    expect(serialized).not.toContain("13000000000");
    expect(serialized).not.toContain("also-secret");
    expect(modelMaterial).toContain("sample:job_requisition:1");
    expect(modelMaterial).not.toContain("must-never-persist");
    expect(receipt.findings[0]?.verdict).toBe("citation_valid");

    const sampleBlock = receipt.presentation.blocks.find((block) =>
      block.id.startsWith("instance-sample-"),
    );
    expect(sampleBlock).toMatchObject({
      kind: "table",
      totalRows: 8,
      truncated: true,
    });
  });

  it("marks a full first page as truncated when the source returns nextCursor", async () => {
    const receipt = await analyzeOntology(ontology(), {
      gatewayConfigured: () => false,
      listInstances: async (_domain, objectType) => ({
        items: Array.from({ length: 5 }, (_value, index) => ({
          id: `${objectType}-${index + 1}`,
          status: "active",
        })),
        nextCursor: "cursor-page-2",
      }),
    });

    expect(receipt.instanceSamples[0]).toMatchObject({
      observedRows: 5,
      shownRows: 5,
      truncated: true,
    });
    const sampleBlock = receipt.presentation.blocks.find((block) =>
      block.id.startsWith("instance-sample-"),
    );
    expect(sampleBlock).toMatchObject({
      kind: "table",
      totalRows: 5,
      truncated: true,
    });
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

  it("reports an empty model result instead of silently treating it as a valid interpretation", async () => {
    const events: Array<{
      type: string;
      payload: Record<string, unknown>;
    }> = [];
    const receipt = await analyzeOntology(ontology(), {
      gatewayConfigured: () => true,
      interpret: async () => null,
      onProgress: async (type, payload) => {
        events.push({ type, payload });
      },
    });

    expect(receipt.substrate.interpretation).toBe("empty");
    expect(receipt.limitations.join()).toContain("LLM 返回空内容");
    expect(events).toContainEqual({
      type: "harness.ontology_analysis.interpret_failed",
      payload: { failureKind: "empty_output" },
    });
  });

  it.each([
    [
      "invalid_json",
      { kind: "invalid_json" as const, sample: '{"findings":[' },
      "JSON 无法解析",
    ],
    [
      "no_json",
      { kind: "no_json" as const, sample: "model prose" },
      "不含完整 JSON",
    ],
  ])(
    "persists the %s model failure classification without leaking its sample",
    async (failureKind, failure, expectedMessage) => {
      const events: Array<{
        type: string;
        payload: Record<string, unknown>;
      }> = [];
      const receipt = await analyzeOntology(ontology(), {
        gatewayConfigured: () => true,
        interpretResult: async () => ({ ok: false, failure }),
        onProgress: async (type, payload) => {
          events.push({ type, payload });
        },
      });

      expect(receipt.substrate.interpretation).toBe("empty");
      expect(receipt.structure.counts.links).toBe(1);
      expect(receipt.limitations.join()).toContain(expectedMessage);
      expect(JSON.stringify(receipt)).not.toContain(failure.sample);
      expect(events).toContainEqual({
        type: "harness.ontology_analysis.interpret_failed",
        payload: { failureKind },
      });
    },
  );

  it("reports a syntactically valid but contract-invalid interpretation", async () => {
    const events: Array<{
      type: string;
      payload: Record<string, unknown>;
    }> = [];
    const receipt = await analyzeOntology(ontology(), {
      gatewayConfigured: () => true,
      interpret: async () => ({ unrelated: true }),
      onProgress: async (type, payload) => {
        events.push({ type, payload });
      },
    });

    expect(receipt.substrate.interpretation).toBe("empty");
    expect(receipt.limitations.join()).toContain("不符合 findings/narrative");
    expect(events).toContainEqual({
      type: "harness.ontology_analysis.interpret_failed",
      payload: { failureKind: "schema_invalid" },
    });
  });

  it("propagates progress persistence failures without relabeling them as LLM failures", async () => {
    const events: string[] = [];
    const progressFailure = new Error("progress write failed");

    await expect(
      analyzeOntology(ontology(), {
        gatewayConfigured: () => true,
        interpret: async () => ({
          findings: [
            {
              claim: "岗位发布引用需求单",
              refs: ["Job_Posting", "Job_Requisition"],
            },
          ],
          narrative: "模型解释完成。",
        }),
        onProgress: async (type) => {
          events.push(type);
          if (type === "harness.ontology_analysis.interpret_completed") {
            throw progressFailure;
          }
        },
      }),
    ).rejects.toBe(progressFailure);

    expect(events).toContain("harness.ontology_analysis.interpret_completed");
    expect(events).not.toContain("harness.ontology_analysis.interpret_failed");
  });

  it("routes the default interpretation through the tenant-aware central gateway", async () => {
    const controller = new AbortController();
    const chat = vi.fn(async () => ({
      text: JSON.stringify({
        findings: [
          {
            claim: "岗位发布引用需求单",
            refs: ["Job_Posting", "Job_Requisition"],
          },
        ],
        narrative: "租户路由模型解释。",
      }),
      provider: "custom" as const,
      model: "tenant-analyst-model",
      tokensIn: 20,
      tokensOut: 12,
      finishReason: "stop" as const,
      latencyMs: 18,
    }));
    _setLLMGatewayForTests({
      defaultProvider: "custom",
      defaultModel: "tenant-analyst-model",
      chat,
    } as never);

    const receipt = await analyzeOntology(ontology(), {
      tenantId: "tenant-agents-generation",
      tenantSlug: "agents-generation",
      signal: controller.signal,
    });

    expect(receipt.substrate.interpretation).toBe("available");
    expect(receipt.findings[0]?.verdict).toBe("citation_valid");
    expect(chat).toHaveBeenCalledTimes(1);
    expect(chat).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: "tenant-agents-generation",
        tenantSlug: "agents-generation",
        purpose: "ontocode.ontology_analysis",
        routing: { taskType: "ontology.query" },
        jsonMode: true,
        signal: controller.signal,
        store: false,
      }),
    );
  });

  it("refuses canned mock gateway output as an Analyst result", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const chat = vi.fn(async () => ({
      text: JSON.stringify({
        findings: [
          {
            claim: "罐头结论",
            refs: ["Job_Posting"],
          },
        ],
        narrative: "mock",
      }),
      provider: "mock" as const,
      model: "mock-model-v1",
      tokensIn: 1,
      tokensOut: 1,
      finishReason: "stop" as const,
      latencyMs: 1,
    }));
    _setLLMGatewayForTests({
      defaultProvider: "mock",
      defaultModel: "mock-model-v1",
      chat,
    } as never);

    const receipt = await analyzeOntology(ontology(), {
      tenantId: "tenant-agents-generation",
      tenantSlug: "agents-generation",
    });

    expect(chat).toHaveBeenCalledTimes(2);
    expect(receipt.substrate.interpretation).toBe("empty");
    expect(receipt.findings).toEqual([]);
    expect(JSON.stringify(receipt)).not.toContain("罐头结论");
    expect(receipt.limitations.join()).toContain("LLM 调用失败");
  });

  it("bounds the interpretation contract and persisted model output", async () => {
    let modelSystem = "";
    const receipt = await analyzeOntology(ontology(), {
      gatewayConfigured: () => true,
      interpret: async (system) => {
        modelSystem = system;
        return {
          findings: Array.from({ length: 20 }, (_value, index) => ({
            claim: `${index}:${"结论".repeat(300)}`,
            refs: [
              "Job_Posting",
              ...Array.from({ length: 20 }, () => "Job_Requisition"),
            ],
          })),
          narrative: "叙述".repeat(2_000),
        };
      },
    });

    expect(modelSystem).toContain("最多 8 条 findings");
    expect(modelSystem).toContain("一次性闭合 JSON");
    expect(receipt.findings).toHaveLength(8);
    expect(receipt.findings[0]?.claim.length).toBeLessThanOrEqual(320);
    expect(receipt.findings[0]?.refs).toHaveLength(12);
    expect(receipt.narrative?.length).toBeLessThanOrEqual(1_200);
    expect(receipt.substrate.interpretation).toBe("available");
  });
});

describe("ontology_analysis wiring", () => {
  it("is a registered executor kind, so a queued job actually runs", async () => {
    const { createDefaultOntoCodeHarnessExecutors } =
      await import("../src/services/ontocode-harness-worker");
    const executors = createDefaultOntoCodeHarnessExecutors({
      fetchOntology: async () => ontology(),
      runBuild: async () => {
        throw new Error("not used");
      },
      runCandidateTest: async () => {
        throw new Error("not used");
      },
    } as never);
    expect(typeof executors.ontology_analysis).toBe("function");
  });

  it("maps to a read_only command policy that needs no human approval", async () => {
    const { ONTOCODE_COMMAND_POLICY } = await import("@agentic/contracts");
    const policy = ONTOCODE_COMMAND_POLICY.analyze_ontology;
    expect(policy.jobKind).toBe("ontology_analysis");
    expect(policy.riskClass).toBe("read_only");
    expect(policy.requiresHuman).toBe(false);
  });
});
