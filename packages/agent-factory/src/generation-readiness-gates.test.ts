import { describe, expect, it } from "vitest";
import { FACTORY_TOOLS } from "./tools";
import type { BrainCtx } from "./brain-types";
import type { DomainOntology } from "./ontology-types";
import { sanitizeSensitiveInput } from "./sensitive-input";
import {
  catalogToolDefinitionHash,
  declarativeToolDefinitionHash,
} from "./declarative-tool-hash";
import { factorySourceOntologyHash } from "./generation-directive";
import { ontologyContentHash } from "./evidence-fingerprint";
import { consumeIntegrationSelectionAnswer } from "./integration-binding";

const readOntology = FACTORY_TOOLS.find(
  (tool) => tool.name === "read_ontology",
)!;
const readActionContract = FACTORY_TOOLS.find(
  (tool) => tool.name === "read_action_contract",
)!;
const inspectActionReadiness = FACTORY_TOOLS.find(
  (tool) => tool.name === "inspect_action_readiness",
)!;
const inspectAllActionReadiness = FACTORY_TOOLS.find(
  (tool) => tool.name === "inspect_all_action_readiness",
)!;
const analyzeWithCode = FACTORY_TOOLS.find(
  (tool) => tool.name === "analyze_with_code",
)!;
const reviseOntology = FACTORY_TOOLS.find(
  (tool) => tool.name === "revise_ontology",
)!;
const designAgent = FACTORY_TOOLS.find((tool) => tool.name === "design_agent")!;
const createTool = FACTORY_TOOLS.find((tool) => tool.name === "create_tool")!;

function validOntology(): DomainOntology {
  return {
    domainId: "test",
    source: "allmeta",
    objects: [
      {
        id: "Work",
        name: "Work",
        primary_key: "work_id",
        properties: [
          { name: "work_id", type: "String" },
          { name: "result", type: "String" },
        ],
      },
    ],
    rules: [],
    events: [
      {
        name: "WORK_REQUESTED",
        payload: {
          source_action: null,
          event_data: [
            { name: "work_id", type: "String", target_object: "Work" },
          ],
          state_mutations: [],
        },
      },
      {
        name: "WORK_DONE",
        payload: {
          source_action: "doWork",
          event_data: [
            { name: "result", type: "String", target_object: "Work" },
          ],
          state_mutations: [
            {
              target_object: "Work",
              mutation_type: "MODIFY",
              impacted_properties: ["result"],
            },
          ],
        },
      },
    ],
    actions: [
      {
        id: "a1",
        name: "doWork",
        actor: ["Agent"],
        trigger: ["WORK_REQUESTED"],
        triggered_event: ["WORK_DONE"],
        target_objects: ["Work"],
        tool_use: [],
        system_prompt: "",
        user_prompt: "",
        inputs: [
          {
            name: "work_id",
            type: "String",
            required: true,
            binding_kind: "event",
            event_field: "work_id",
            source_object: "Work.work_id",
          },
        ],
        outputs: [{ name: "result", type: "String" }],
        action_steps: [{ id: "fetch", name: "fetch", type: "tool" }],
        integration: {
          systems: [
            {
              name: "Vendor",
              kind: "external_api",
              role: "reads",
              capability: "GET /lookup",
              objects: ["Work"],
            },
          ],
        },
      },
    ],
    workflow: [{ id: "flow" }],
  } as unknown as DomainOntology;
}

function context(ontology: DomainOntology): BrainCtx {
  const defaultTool = {
    name: "vendor.lookup",
    description: "lookup",
    method: "GET",
    urlTemplate: "https://api.example.com/{work_id}",
    sideEffect: "read" as const,
    operation: "read" as const,
    effectScope: "external" as const,
    sandboxPolicy: "live_external" as const,
    domain: "test",
    capabilities: [
      {
        systems: ["Vendor"],
        kinds: ["external_api"],
        roles: ["reads"],
        operations: ["lookup"],
        objectTypes: ["Work"],
      },
    ],
    probeStatus: "verified" as const,
  };
  const defaultDefinitionHash = declarativeToolDefinitionHash(
    defaultTool,
    {},
    process.env,
  );
  return {
    domain: "test",
    goal: "build",
    emit: () => {},
    specs: [],
    ontology: null,
    currentPlan: null,
    toolCatalog: [],
    realTools: [],
    attemptHistory: {},
    createdSkills: [],
    research: [],
    priorReflections: [],
    humanDirectives: [],
    lastSandbox: null,
    lastValidation: null,
    budget: { maxTokens: null, maxTurns: 20 },
    spent: { tokens: 0, turns: 0, sandboxRuns: 0 },
    ports: {
      ontology: {
        fetchOntology: async () => ontology,
        listDomains: async () => [],
        fetchActionRules: async () => [],
      },
      tools: {
        list: async () => [
          {
            ...defaultTool,
            definitionHash: defaultDefinitionHash,
            verifiedDefinitionHashes: [defaultDefinitionHash],
            productionVerifiedDefinitionHashes: [defaultDefinitionHash],
            probeEvidenceMode: "live-probe" as const,
          },
        ],
        saveDraft: async () => ({
          revisionId: "tvr-test-default",
          version: 1,
          definitionHash: "a".repeat(64),
          status: "draft" as const,
        }),
      },
      toolRegistry: { list: async () => [] },
      skills: {
        list: async () => [],
        save: async () => {},
        bumpUse: async () => {},
        recordEval: async () => {},
      },
    },
  } as unknown as BrainCtx;
}

describe("generation readiness gates", () => {
  it("gives analyze_with_code an exact derived agentActions alias and fails plainly before Ontology is loaded", async () => {
    const ctx = context(validOntology());
    const missing = await analyzeWithCode.execute(
      {
        purpose: "count agent actions",
        code: "return input.ontology.agentActions.length;",
      },
      ctx,
    );
    expect(missing.ok).toBe(false);
    expect(missing.summary).toContain("read_ontology");

    await readOntology.execute({}, ctx);
    const analyzed = await analyzeWithCode.execute(
      {
        purpose: "verify aliases",
        code: "return {all: input.ontology.actions.length, agents: input.ontology.agentActions.map(function (a) { return a.name; })};",
      },
      ctx,
    );
    expect(analyzed.ok).toBe(true);
    expect(analyzed.output).toMatchObject({
      result: { all: 1, agents: ["doWork"] },
    });
  });

  it("keeps read_ontology compact while retaining exact Action identity and selected scope", async () => {
    const ontology = validOntology();
    const second = structuredClone(ontology.actions[0]!);
    Object.assign(second, { id: "a2", name: "doSecondWork" });
    ontology.actions.push(second);
    const hidden = `HIDDEN-${"x".repeat(12_000)}`;
    ontology.actions[0]!.system_prompt = hidden;
    ontology.actions[0]!.inputs = [
      {
        name: "work_id",
        type: "String",
        required: true,
        binding_kind: "event",
        event_field: "work_id",
        source_object: "Work.work_id",
        internal_detail: hidden,
      },
    ];
    for (let index = 0; index < 49; index++) {
      ontology.objects.push({
        id: `Object_${index}`,
        name: `Object ${index}`,
        description: hidden,
        primary_key: `object_${index}_id`,
        properties: [
          {
            name: `object_${index}_id`,
            type: "String",
            description: hidden,
          },
        ],
      });
    }
    for (let index = 0; index < 70; index++) {
      ontology.rules.push({
        id: `rule-${index}`,
        name: `Rule ${index}`,
        description: hidden,
      });
    }
    const ctx = context(ontology);
    ctx.generationDirective = {
      schema: "agent-factory-generation-directive/v1",
      mode: "action_selection",
      requestedActionIds: ["a1"],
      requestedActionNames: ["doWork"],
      requestedActions: [{ id: "a1", name: "doWork" }],
      sourceOntologyHash: factorySourceOntologyHash(ontology),
    };

    const result = await readOntology.execute({}, ctx);
    expect(result.ok).toBe(true);
    expect(result.output).toMatchObject({
      domain: "test",
      source: "allmeta",
      source_scope: {
        action_ids: ["a1"],
        action_names: ["doWork"],
        selected_agent_actions: 1,
        all_agent_actions: 2,
      },
      domain_summary: {
        counts: {
          actions: 2,
          agentActions: 2,
          events: 2,
          objects: 50,
          rules: 70,
        },
      },
      agentActions: [
        {
          id: "a1",
          name: "doWork",
          actor: ["Agent"],
          trigger: ["WORK_REQUESTED"],
          triggered_event: ["WORK_DONE"],
          selected: true,
          scope_status: "selected",
        },
        {
          id: "a2",
          name: "doSecondWork",
          selected: false,
          scope_status: "excluded",
        },
      ],
      ontology_readiness: {
        counts: expect.objectContaining({ actions: 1 }),
        blocking: { count: expect.any(Number), gapKeys: expect.any(Array) },
        warnings: { count: expect.any(Number), gapKeys: expect.any(Array) },
      },
      progressive_disclosure: { nextTool: "read_action_contract" },
    });
    const serialized = JSON.stringify(result.output);
    expect(serialized).not.toContain(hidden);
    expect(serialized).not.toContain('"inputs"');
    expect(serialized).not.toContain('"action_steps"');
    expect(serialized).not.toContain('"integrationProfiles"');
    expect(serialized.length).toBeLessThan(24_000);
    // Progressive disclosure changes only the transcript, never the full
    // server-side validation copy.
    expect(ctx.ontology?.actions[0]?.system_prompt).toBe(hidden);
    expect(ctx.ontology?.actions[0]?.inputs?.[0]?.internal_detail).toBe(hidden);
  });

  it("reads one selected Action's complete authoritative contract with stable provenance", async () => {
    const ontology = validOntology();
    const action = ontology.actions[0]!;
    action.outputs = [
      { name: "result", type: "String", source_object: "Work.result" },
    ];
    action.action_steps = [
      {
        order: 0,
        step_id: "fetch",
        name: "fetch",
        type: "tool",
        tool: "vendor.lookup",
        rules: [{ id: "policy-1" }],
      },
    ];
    action.integration = {
      systems: [
        {
          call_order: 1,
          name: "Vendor",
          kind: "external_api",
          role: "reads",
          capability: "GET /lookup",
          objects: ["Work"],
        },
      ],
    };
    action.side_effects = {
      data_changes: [{ object_type: "Work", action: "MODIFY" }],
    };
    ontology.rules = [
      {
        id: "policy-1",
        name: "Current work policy",
        description: "Authoritative rule body",
      },
    ];
    const ctx = context(ontology);
    await readOntology.execute({}, ctx);

    const first = await readActionContract.execute({ action: "doWork" }, ctx);
    const second = await readActionContract.execute({ action: "doWork" }, ctx);

    expect(first.ok).toBe(true);
    expect(first.output).toMatchObject({
      readOnly: true,
      provenance: {
        schema: "agent-factory-action-contract/v1",
        domainId: "test",
        ontologySource: "allmeta",
        actionId: "a1",
        actionName: "doWork",
        selected: true,
        authoritative: true,
        ontologyHash: expect.stringMatching(/^ontology:v2:[a-f0-9]{64}$/),
        sliceHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      },
      readiness: { ontologyReady: true, rulesReady: true },
      contract: {
        action: {
          inputs: expect.any(Array),
          outputs: [
            { name: "result", type: "String", source_object: "Work.result" },
          ],
          action_steps: [expect.objectContaining({ step_id: "fetch" })],
          integration: expect.any(Object),
          side_effects: expect.any(Object),
        },
        rules: {
          relevant: [expect.objectContaining({ id: "policy-1" })],
          unresolved: [],
        },
        events: expect.arrayContaining([
          expect.objectContaining({ name: "WORK_REQUESTED" }),
          expect.objectContaining({ name: "WORK_DONE" }),
        ]),
        objects: [expect.objectContaining({ id: "Work" })],
        integrationRequirements: [
          expect.objectContaining({ id: "a1:integration:1", system: "Vendor" }),
        ],
      },
    });
    expect(
      (second.output as { provenance: { sliceHash: string } }).provenance
        .sliceHash,
    ).toBe(
      (first.output as { provenance: { sliceHash: string } }).provenance
        .sliceHash,
    );
    expect(JSON.stringify(first.output).length).toBeLessThan(48_000);
  });

  it("fails read_action_contract closed for unknown, non-Agent, and out-of-scope Actions", async () => {
    const ontology = validOntology();
    ontology.actions.push({
      ...structuredClone(ontology.actions[0]!),
      id: "human-1",
      name: "manualReview",
      actor: ["Human"],
    });
    const ctx = context(ontology);
    await readOntology.execute({}, ctx);

    await expect(
      readActionContract.execute({ action: "ghostAction" }, ctx),
    ).resolves.toMatchObject({
      ok: false,
      output: { reason: "unknown_action", knownAgentActions: ["doWork"] },
    });
    await expect(
      readActionContract.execute({ action: "manualReview" }, ctx),
    ).resolves.toMatchObject({
      ok: false,
      output: { reason: "action_actor_not_agent" },
    });
    ctx.generationDirective = {
      requestedActionNames: ["someOtherAction"],
      mode: "action_selection",
    } as never;
    await expect(
      readActionContract.execute({ action: "doWork" }, ctx),
    ).resolves.toMatchObject({
      ok: false,
      output: {
        reason: "action_outside_generation_scope",
        allowedActionNames: ["someOtherAction"],
      },
    });
  });

  it("inspects one action without requiring or creating a plan/spec", async () => {
    const ctx = context(validOntology());
    await readOntology.execute({}, ctx);
    expect(ctx.currentPlan).toBeNull();
    expect(ctx.specs).toHaveLength(0);

    const inspected = await inspectActionReadiness.execute(
      { action: "doWork" },
      ctx,
    );

    expect(inspected.ok).toBe(true);
    expect(inspected.output).toMatchObject({
      action: "doWork",
      ready: true,
      readOnly: true,
      ontology: { ready: true, blockers: [] },
      rules: { unresolved: [], needsUserInput: false },
      integration: { ready: true },
      profiles: { ready: true },
      probes: { ready: true },
    });
    expect(ctx.currentPlan).toBeNull();
    expect(ctx.specs).toHaveLength(0);
  });

  it("does not turn post-authoring profile gaps into a config wait before design_agent succeeds", async () => {
    const ctx = context(validOntology());
    await readOntology.execute({}, ctx);
    ctx.currentPlan = {
      summary: "generate doWork",
      agents: [
        {
          actionName: "doWork",
          role: "worker",
          triggerEvents: ["WORK_REQUESTED"],
          emitEvents: ["WORK_DONE"],
          toolCandidates: ["vendor.lookup"],
          edgeCases: [],
        },
      ],
      notes: [],
      version: 1,
    };

    const inspected = await inspectActionReadiness.execute(
      { action: "doWork" },
      ctx,
    );

    expect(inspected).toMatchObject({
      ok: false,
      output: {
        action: "doWork",
        next: "design_agent",
        reason: "planned_action_not_designed",
        missing: ["successful_agent_design"],
      },
    });
    expect(inspected.summary).toContain("直到产生 agent.created");
    expect(inspected.output).not.toHaveProperty("compact");
    expect(ctx.specs).toHaveLength(0);
  });

  it("parks read_ontology when the execution-resource catalog is unavailable", async () => {
    const ctx = context(validOntology());
    ctx.ports.toolRegistry = {
      list: async () => {
        throw new Error("catalog offline");
      },
    };

    const result = await readOntology.execute({}, ctx);

    expect(result).toMatchObject({
      ok: false,
      output: {
        next: "ask_user",
        reason: "execution_resources_unavailable",
        missing: ["execution_resources_snapshot"],
      },
    });
    expect(result.summary).toContain("没有可靠清单时不会生成、修改或部署代码");
    expect(ctx.currentPlan).toBeNull();
    expect(ctx.specs).toHaveLength(0);
  });

  it("parks both readiness inspection and design when a fresh resource read fails", async () => {
    const ctx = context(validOntology());
    await readOntology.execute({}, ctx);
    ctx.ports.toolRegistry = {
      list: async () => {
        throw new Error("catalog offline");
      },
    };

    const one = await inspectActionReadiness.execute({ action: "doWork" }, ctx);
    const all = await inspectAllActionReadiness.execute({}, ctx);
    const designed = await designAgent.execute(
      {
        action: "doWork",
        system_prompt: "按契约处理输入。",
        decision_logic: "成功后发出 WORK_DONE。",
      },
      ctx,
    );

    expect(one).toMatchObject({
      ok: false,
      output: { next: "ask_user", reason: "execution_resources_unavailable" },
    });
    expect(all).toMatchObject({
      ok: false,
      output: { next: "ask_user", reason: "execution_resources_unavailable" },
    });
    expect(designed).toMatchObject({
      ok: false,
      output: { next: "ask_user", reason: "execution_resources_unavailable" },
    });
    expect(ctx.currentPlan).toBeNull();
    expect(ctx.specs).toHaveLength(0);
  });

  it("turns authoritative readiness gaps into enforced ask_user control flow", async () => {
    const ontology = validOntology();
    // A same-name, type-compatible Event field is now normalized
    // deterministically. Keep this fixture genuinely unresolved so the test
    // continues to exercise the ask_user branch rather than an old false
    // blocker.
    ontology.actions[0]!.inputs = [
      { name: "request_key", type: "String", required: true },
    ];
    const ctx = context(ontology);
    await readOntology.execute({}, ctx);

    const inspected = await inspectActionReadiness.execute(
      { action: "doWork" },
      ctx,
    );

    expect(inspected).toMatchObject({
      ok: true,
      output: {
        ready: false,
        next: "ask_user",
        reason: "action_readiness_requires_authoritative_input",
        missing: expect.arrayContaining(["authoritative_ontology_corrections"]),
      },
    });
    expect((inspected.output as { question: string }).question).toContain(
      "不会自行补路由、字段、规则或凭证",
    );
    expect(ctx.currentPlan).toBeNull();
    expect(ctx.specs).toHaveLength(0);
  });

  it("derives and inspects the complete Agent action set from Ontology with one read-only snapshot", async () => {
    const ontology = validOntology();
    const second = structuredClone(ontology.actions[0]!);
    Object.assign(second, {
      id: "a2",
      name: "doSecondWork",
      trigger: ["SECOND_WORK_REQUESTED"],
      triggered_event: ["SECOND_WORK_DONE"],
    });
    ontology.actions.push(second, {
      id: "human-1",
      name: "manualReview",
      actor: ["Human"],
      trigger: [],
      triggered_event: [],
      target_objects: ["Work"],
      tool_use: [],
      system_prompt: "",
      user_prompt: "",
      inputs: [],
      outputs: [],
      action_steps: [],
      integration: { systems: [] },
    });
    ontology.events.push(
      {
        name: "SECOND_WORK_REQUESTED",
        payload: {
          source_action: null,
          event_data: [
            { name: "work_id", type: "String", target_object: "Work" },
          ],
          state_mutations: [],
        },
      },
      {
        name: "SECOND_WORK_DONE",
        payload: {
          source_action: "doSecondWork",
          event_data: [
            { name: "result", type: "String", target_object: "Work" },
          ],
          state_mutations: [
            {
              target_object: "Work",
              mutation_type: "MODIFY",
              impacted_properties: ["result"],
            },
          ],
        },
      },
    );
    const ctx = context(ontology);
    await readOntology.execute({}, ctx);

    let registryReads = 0;
    let declarativeReads = 0;
    let capabilityReads = 0;
    let writesOrRuns = 0;
    const registeredTools = await ctx.ports.toolRegistry!.list();
    const declarativeTools = await ctx.ports.tools!.list(ctx.domain);
    ctx.ports.toolRegistry = {
      list: async () => {
        registryReads += 1;
        return registeredTools;
      },
    };
    ctx.ports.tools = {
      list: async () => {
        declarativeReads += 1;
        return declarativeTools;
      },
      saveDraft: async () => {
        writesOrRuns += 1;
        return {
          revisionId: "tvr-must-not-save",
          version: 1,
          definitionHash: "a".repeat(64),
          status: "draft",
        };
      },
      probe: async () => {
        writesOrRuns += 1;
        return {
          verified: false,
          classification: "must_not_probe",
          definitionHash: "unused",
          schemaHash: "unused",
          durationMs: 0,
        };
      },
    };
    ctx.ports.integrationCapabilities = {
      list: async () => {
        capabilityReads += 1;
        return [];
      },
    };
    ctx.ports.integrationProfiles = {
      save: async () => {
        writesOrRuns += 1;
        throw new Error("must not save");
      },
    };
    ctx.ports.sandbox = {
      deployAndObserve: async () => {
        writesOrRuns += 1;
        throw new Error("must not deploy");
      },
      teardown: async () => {
        writesOrRuns += 1;
      },
    };
    const emitted: unknown[] = [];
    ctx.emit = (event) => {
      emitted.push(event);
    };
    const stateBefore = JSON.stringify({
      ontology: ctx.ontology,
      readiness: ctx.ontologyReadiness,
      plan: ctx.currentPlan,
      specs: ctx.specs,
      testCases: ctx.testCases,
      lastSandbox: ctx.lastSandbox,
    });

    const schema = inspectAllActionReadiness.parameters as {
      additionalProperties?: boolean;
      properties?: Record<string, unknown>;
    };
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties).not.toHaveProperty("actions");
    expect(schema.properties).not.toHaveProperty("action");

    // Even a direct executor call that bypasses JSON-schema validation cannot
    // replace the Ontology-derived catalog with a hallucinated list.
    const result = await inspectAllActionReadiness.execute(
      {
        reasoning: "check every real action",
        actions: ["ghostAction"],
      },
      ctx,
    );
    expect(result.ok).toBe(true);
    expect(result.output).toMatchObject({
      readOnly: true,
      source: "ontology.agent_actions",
      actionNames: ["doWork", "doSecondWork"],
      totals: {
        total: 2,
        ready: 2,
        blocked: 0,
        readyActions: ["doWork", "doSecondWork"],
        blockedActions: [],
      },
    });
    const reports = (
      result.output as { actions: Array<Record<string, unknown>> }
    ).actions;
    expect(reports.map((report) => report.action)).toEqual([
      "doWork",
      "doSecondWork",
    ]);
    expect(reports).toHaveLength(2);
    for (const report of reports) {
      expect(report).toMatchObject({
        ready: true,
        readOnly: true,
        stages: { authoring: true, sandbox: true, promotion: true },
        blockers: {
          categories: [],
          ontology: { count: 0, examples: [] },
          rules: { count: 0, examples: [] },
          integration: { ready: true, unresolvedBindings: [] },
          profiles: { sandboxReady: true, productionReady: true },
          probes: { sandboxReady: true, promotionReady: true },
        },
        detail: { tool: "inspect_action_readiness" },
      });
      expect(report).not.toHaveProperty("integrationGate");
      expect(report).not.toHaveProperty("profileGate");
      expect(report).not.toHaveProperty("probeGate");
    }
    const serialized = JSON.stringify(
      sanitizeSensitiveInput(result.output, "aggregate-readiness").sanitized,
    );
    expect(serialized).not.toContain("[REDACTED_CIRCULAR]");
    expect(serialized.length).toBeLessThan(12_000);
    expect(registryReads).toBe(1);
    expect(declarativeReads).toBe(1);
    expect(capabilityReads).toBe(1);
    expect(writesOrRuns).toBe(0);
    expect(emitted).toEqual([]);
    expect(
      JSON.stringify({
        ontology: ctx.ontology,
        readiness: ctx.ontologyReadiness,
        plan: ctx.currentPlan,
        specs: ctx.specs,
        testCases: ctx.testCases,
        lastSandbox: ctx.lastSandbox,
      }),
    ).toBe(stateBefore);
  });

  it("inspects only the server-selected generation scope and ignores out-of-scope blockers", async () => {
    const ontology = validOntology();
    const blockedOutsideScope = structuredClone(ontology.actions[0]!);
    Object.assign(blockedOutsideScope, {
      id: "a2",
      name: "blockedOutsideScope",
      inputs: [
        {
          name: "missing_authoritative_route",
          type: "String",
          required: true,
        },
      ],
    });
    ontology.actions.push(blockedOutsideScope);
    const ctx = context(ontology);
    ctx.generationDirective = {
      schema: "agent-factory-generation-directive/v1",
      mode: "action_selection",
      requestedActionIds: ["a1"],
      requestedActionNames: ["doWork"],
      requestedActions: [{ id: "a1", name: "doWork" }],
      sourceOntologyHash: factorySourceOntologyHash(ontology),
    };

    await readOntology.execute({}, ctx);
    const result = await inspectAllActionReadiness.execute({}, ctx);

    expect(result).toMatchObject({
      ok: true,
      output: {
        readOnly: true,
        source: "generation.directive.agent_actions",
        actionNames: ["doWork"],
        totals: {
          total: 1,
          ready: 1,
          blocked: 0,
          readyActions: ["doWork"],
          blockedActions: [],
        },
      },
    });
    expect(JSON.stringify(result.output)).not.toContain("blockedOutsideScope");
  });

  it("refuses to turn a Human action into a generated function", async () => {
    const ontology = validOntology();
    ontology.actions[0]!.name = "manualApproval";
    ontology.actions[0]!.actor = ["Human"];
    ontology.actions[0]!.action_steps = [];
    ontology.actions[0]!.integration = { systems: [] };
    ontology.events[1]!.payload.source_action = "manualApproval";
    const ctx = context(ontology);

    const read = await readOntology.execute({}, ctx);
    expect((read.output as { agentActions: unknown[] }).agentActions).toEqual(
      [],
    );

    const result = await designAgent.execute(
      {
        action: "manualApproval",
        system_prompt: "执行人工审批。",
        decision_logic: "审批后完成。",
      },
      ctx,
    );

    expect(result).toMatchObject({
      ok: false,
      output: {
        next: "ask_user",
        reason: "action_actor_not_agent",
        action: "manualApproval",
        actor: ["Human"],
      },
    });
    expect(result.summary).toContain("不会把人工/平台操作伪装成 Agent");
    expect(ctx.specs).toHaveLength(0);
  });

  it("honors Ontology action.tool_use during readiness instead of inventing an ambiguous tool choice", async () => {
    const ontology = validOntology();
    ontology.actions[0]!.tool_use = ["vendor.alpha"];
    const ctx = context(ontology);
    ctx.ports.tools!.list = async () => [];
    const capability = {
      systems: ["Vendor"],
      kinds: ["external_api"],
      roles: ["reads"],
      operations: ["lookup"],
      objectTypes: ["Work"],
    };
    ctx.ports.toolRegistry = {
      list: async () => [
        {
          name: "vendor.alpha",
          operation: "read",
          effectScope: "external",
          sandboxPolicy: "live_external",
          capabilities: [capability],
        },
        {
          name: "vendor.beta",
          operation: "read",
          effectScope: "external",
          sandboxPolicy: "live_external",
          capabilities: [capability],
        },
      ],
    };
    await readOntology.execute({}, ctx);

    const result = await inspectAllActionReadiness.execute({}, ctx);

    expect(result).toMatchObject({
      ok: true,
      output: {
        totals: { total: 1, ready: 1, blocked: 0 },
        actions: [
          {
            blockers: {
              integration: {
                ready: true,
                declaredTools: ["vendor.alpha"],
                selectedTools: ["vendor.alpha"],
                unresolvedBindings: [],
              },
            },
            detail: { tool: "inspect_action_readiness", action: "doWork" },
          },
        ],
      },
    });
    expect(JSON.stringify(result.output)).not.toContain("vendor.beta");
  });

  it("keeps aggregate blockers traceable without returning full binding/profile/probe reports", async () => {
    const ontology = validOntology();
    const ctx = context(ontology);
    ctx.ports.tools!.list = async () => [];
    ctx.ports.toolRegistry = { list: async () => [] };
    await readOntology.execute({}, ctx);

    const result = await inspectAllActionReadiness.execute({}, ctx);
    expect(result).toMatchObject({
      ok: true,
      output: {
        totals: { total: 1, ready: 0, blocked: 1 },
        actions: [
          {
            action: "doWork",
            stages: { authoring: false, sandbox: false, promotion: false },
            blockers: {
              integration: {
                identityGapRequirementIds: ["a1:integration:1"],
                unresolvedBindings: [
                  {
                    requirementId: "a1:integration:1",
                    system: "Vendor",
                    kind: "external_api",
                    role: "reads",
                    status: "missing",
                    reason: expect.stringContaining("没有工具显式覆盖"),
                  },
                ],
              },
            },
            detail: { tool: "inspect_action_readiness", action: "doWork" },
          },
        ],
      },
    });

    const serialized = JSON.stringify(result.output);
    expect(serialized).not.toContain("integrationGate");
    expect(serialized).not.toContain("profileGate");
    expect(serialized).not.toContain("probeGate");
    expect(serialized).not.toContain("verifiedDefinitionHashes");
    expect(serialized.length).toBeLessThan(8_000);
  });

  it("bounds malformed rule-reference evidence in the aggregate report", async () => {
    const ontology = validOntology();
    ontology.actions[0]!.action_steps = [
      {
        id: "rule",
        name: "rule",
        type: "tool",
        rules: [{ payload: "x".repeat(20_000) }],
      },
    ] as never;
    const ctx = context(ontology);
    ctx.ports.tools!.list = async () => [];
    ctx.ports.toolRegistry = { list: async () => [] };
    await readOntology.execute({}, ctx);

    const result = await inspectAllActionReadiness.execute({}, ctx);
    const serialized = JSON.stringify(result.output);
    expect(serialized).not.toContain("x".repeat(1_000));
    expect(result.output).toMatchObject({
      actions: [
        {
          blockers: {
            rules: {
              count: 1,
              examples: [
                { reason: "missing_identity", reference: "未标识规则" },
              ],
            },
          },
        },
      ],
    });
    expect(serialized.length).toBeLessThan(8_000);
  });

  it("merges persisted adapters and carries exact integration evidence into the spec", async () => {
    const ctx = context(validOntology());
    const read = await readOntology.execute({}, ctx);
    expect(read.ok).toBe(true);
    expect(ctx.ontologyReadiness?.ready).toBe(true);
    expect(ctx.realTools?.map((tool) => tool.name)).toContain("vendor.lookup");
    const contract = await readActionContract.execute(
      { action: "doWork" },
      ctx,
    );
    expect(contract.output).toMatchObject({
      provenance: {
        schema: "agent-factory-action-contract/v1",
        actionName: "doWork",
        authoritative: true,
      },
      contract: {
        integrationRequirements: [
          {
            system: "Vendor",
            kind: "external_api",
            role: "reads",
          },
        ],
      },
    });
    const readiness = await inspectActionReadiness.execute(
      { action: "doWork" },
      ctx,
    );
    expect(readiness.output).toMatchObject({
      integrationGate: {
        report: { ready: true },
      },
    });

    const designed = await designAgent.execute(
      {
        action: "doWork",
        system_prompt: "按契约读取真实 Vendor 数据，并只输出本体声明字段。",
        decision_logic: "读取成功 emit WORK_DONE；失败按错误策略终止或重试。",
        tools: ["vendor.lookup"],
        plan: [
          {
            stepId: "fetch",
            kind: "tool",
            tool: "vendor.lookup",
            idempotencyKeyFrom: "work_id",
            onError: "terminal",
          },
        ],
      },
      ctx,
    );
    expect(designed.ok).toBe(true);
    expect(ctx.specs[0]?.integrationBindings?.[0]).toMatchObject({
      status: "resolved",
      toolName: "vendor.lookup",
    });
  });

  it("preserves exact action_steps tools even when tool_use and integration discovery are empty", async () => {
    const ontology = validOntology();
    const action = ontology.actions[0]!;
    const exactTools = [
      "objectStore.getObject",
      "parseResumeApi",
      "records.upsert",
    ];
    action.tool_use = [];
    action.integration = { systems: [] };
    action.action_steps = exactTools.map((tool, index) => ({
      step_id: [
        "download_resume_object",
        "parse_resume_structured",
        "persist_candidate_and_resume",
      ][index],
      name: `step-${index + 1}`,
      type: "tool",
      object_type: "tool",
      tool,
    }));
    const ctx = context(ontology);
    ctx.ports.tools!.list = async () => [];
    ctx.ports.toolRegistry = {
      list: async () =>
        exactTools.map((name) => ({
          name,
          operation: "compute" as const,
          effectScope: "none" as const,
          sandboxPolicy: "pure" as const,
        })),
    };

    await readOntology.execute({}, ctx);
    const result = await designAgent.execute(
      {
        action: "doWork",
        system_prompt: "按本体步骤读取对象、解析并持久化结果。",
        decision_logic:
          "三步成功后 emit WORK_DONE；任一步失败都按错误策略终止。",
        plan: exactTools.map((tool, index) => ({
          stepId: [
            "download_resume_object",
            "parse_resume_structured",
            "persist_candidate_and_resume",
          ][index],
          kind: "tool",
          tool,
          idempotencyKeyFrom: "work_id",
          onError: "terminal",
        })),
      },
      ctx,
    );

    expect(result.ok).toBe(true);
    expect(result.output).toMatchObject({
      tools: exactTools,
      toolSelectionSource: "ontology.action_steps",
    });
    expect(ctx.specs[0]?.tools).toEqual(exactTools);
    expect(ctx.specs[0]?.plan?.map((step) => step.tool)).toEqual(exactTools);
  });

  it("fails closed when an explicit via_tool is not in the executable registry", async () => {
    const ontology = validOntology();
    const action = ontology.actions[0]!;
    action.tool_use = [];
    action.action_steps = [
      {
        step_id: "fetch",
        name: "fetch",
        type: "tool",
        object_type: "tool",
        tool: "legacyVendorReader",
      },
    ];
    action.integration = {
      systems: [
        {
          name: "Vendor",
          kind: "external_api",
          role: "reads",
          capability: "GET /lookup",
          via_tool: "legacyVendorReader",
          objects: ["Work"],
        },
      ],
    };
    const ctx = context(ontology);

    await readOntology.execute({}, ctx);
    const readiness = await inspectActionReadiness.execute(
      { action: "doWork" },
      ctx,
    );
    expect(readiness.output).toMatchObject({
      authoringReady: false,
      integrationGate: {
        integrationBackedSubstitution: false,
        missingDeclaredTools: ["legacyVendorReader"],
        exactDeclaredToolGaps: ["legacyVendorReader"],
        effectiveTools: [],
      },
    });

    const result = await designAgent.execute(
      {
        action: "doWork",
        system_prompt: "通过当前租户已授权的 Vendor 读取传输执行查询。",
        decision_logic: "成功 emit WORK_DONE；失败终止。",
        plan: [
          {
            stepId: "fetch",
            kind: "tool",
            tool: "vendor.lookup",
            idempotencyKeyFrom: "work_id",
            onError: "terminal",
          },
        ],
      },
      ctx,
    );
    expect(result.ok).toBe(false);
    expect(result.output).toMatchObject({
      reason: "ontology_execution_tool_missing",
      missing: ["legacyVendorReader"],
    });
  });

  it("clears exact declared gaps per symbol instead of letting one valid processResume projection erase another source-only tool", async () => {
    const ontology = validOntology();
    const action = ontology.actions[0]!;
    action.name = "processResume";
    ontology.events[1]!.payload.source_action = "processResume";
    action.tool_use = ["legacyVendorReader", "missing.exact.reader"];
    action.action_steps = [
      {
        step_id: "fetch",
        name: "fetch",
        type: "tool",
        object_type: "tool",
        tool: "legacyVendorReader",
      },
    ];
    action.integration = {
      systems: [
        {
          name: "Vendor",
          kind: "external_api",
          role: "reads",
          capability: "GET /lookup",
          objects: ["Work"],
        },
      ],
    };
    const ctx = context(ontology);

    await readOntology.execute({}, ctx);
    expect(ctx.toolCatalog).toEqual(["vendor.lookup"]);
    expect(ctx.toolCatalog).not.toContain("legacyVendorReader");
    expect(ctx.toolCatalog).not.toContain("missing.exact.reader");
    expect(ctx.sourceDeclarations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "processResume",
          symbol: "legacyVendorReader",
          status: "integration_projected",
          canonical_tool: "vendor.lookup",
        }),
        expect.objectContaining({
          action: "processResume",
          symbol: "missing.exact.reader",
          status: "source_only_unresolved",
          canonical_tool: null,
        }),
      ]),
    );
    const readiness = await inspectActionReadiness.execute(
      { action: "processResume" },
      ctx,
    );

    expect(readiness.output).toMatchObject({
      authoringReady: false,
      integrationGate: {
        integrationBackedSubstitution: true,
        missingDeclaredTools: [
          "legacyVendorReader",
          "missing.exact.reader",
        ],
        exactDeclaredToolGaps: ["missing.exact.reader"],
        effectiveTools: ["vendor.lookup"],
      },
    });
  });

  it("normalizes a registered tool alias in both the Ontology contract and submitted plan", async () => {
    const ontology = validOntology();
    const action = ontology.actions[0]!;
    action.tool_use = ["parseResumeApi"];
    action.action_steps = [
      {
        step_id: "parse",
        name: "parse",
        type: "tool",
        object_type: "tool",
        tool: "parseResumeApi",
      },
    ];
    action.integration = {
      systems: [
        {
          name: "GoHire_System",
          kind: "external_api",
          role: "execute",
          capability: "resume.parse",
          objects: ["Work"],
        },
      ],
    };
    const ctx = context(ontology);
    ctx.ports.tools!.list = async () => [];
    ctx.ports.toolRegistry = {
      list: async () => [
        {
          name: "gohireParseResumeApi",
          aliases: ["parseResumeApi"],
          operation: "compute",
          effectScope: "external",
          sandboxPolicy: "live_external",
          capabilities: [
            {
              systems: ["GoHire_System"],
              kinds: ["external_api"],
              roles: ["execute"],
              operations: ["resume.parse"],
              objectTypes: ["Work"],
            },
          ],
        },
      ],
    };

    await readOntology.execute({}, ctx);
    const result = await designAgent.execute(
      {
        action: "doWork",
        system_prompt: "只调用当前 GoHire 简历解析执行面并返回真实解析结果。",
        decision_logic: "解析成功 emit WORK_DONE；依赖失败终止或停靠。",
        plan: [
          {
            stepId: "parse",
            kind: "tool",
            tool: "gohireParseResumeApi",
            idempotencyKeyFrom: "work_id",
            onError: "terminal",
          },
        ],
      },
      ctx,
    );

    expect(result.ok, result.summary).toBe(true);
    expect(result.output).toMatchObject({
      tools: ["gohireParseResumeApi"],
    });
    expect(ctx.specs[0]?.plan?.[0]?.tool).toBe("gohireParseResumeApi");
  });

  it("projects a one-to-one legacy action-step tool onto the final exact integration binding", async () => {
    const ontology = validOntology();
    const action = ontology.actions[0]!;
    action.tool_use = ["legacyVendorReader"];
    action.action_steps = [
      {
        step_id: "fetch",
        name: "fetch",
        type: "tool",
        object_type: "tool",
        tool: "legacyVendorReader",
      },
    ];
    action.integration = {
      systems: [
        {
          name: "Vendor",
          kind: "external_api",
          role: "reads",
          capability: "GET /lookup",
          objects: ["Work"],
        },
      ],
    };
    const ctx = context(ontology);

    await readOntology.execute({}, ctx);
    const result = await designAgent.execute(
      {
        action: "doWork",
        system_prompt: "通过已解析的 Vendor 查询执行面读取真实数据。",
        decision_logic: "读取成功 emit WORK_DONE；失败终止。",
        plan: [
          {
            stepId: "fetch",
            kind: "tool",
            tool: "legacyVendorReader",
            idempotencyKeyFrom: "work_id",
            onError: "terminal",
          },
        ],
      },
      ctx,
    );

    expect(result.ok, result.summary).toBe(true);
    expect(result.output).toMatchObject({
      tools: ["vendor.lookup"],
    });
    expect(ctx.specs[0]?.plan?.[0]?.tool).toBe("vendor.lookup");
    expect(ctx.specs[0]?.unresolvedTools).toContain("legacyVendorReader");
  });

  it("projects a complete ordered legacy boundary sequence while preserving exact registered anchors", async () => {
    const ontology = validOntology();
    const action = ontology.actions[0]!;
    action.tool_use = [
      "loadLegacyRequirement",
      "generateJdApi",
      "persistLegacyEntity",
      "mirrorLegacyInstance",
    ];
    action.action_steps = action.tool_use.map((tool, index) => ({
      order: index,
      step_id: `boundary-${index + 1}`,
      name: `boundary-${index + 1}`,
      type: "tool",
      object_type: "tool",
      tool,
    }));
    action.integration = {
      systems: [
        {
          call_order: 1,
          name: "RAAS_System",
          kind: "database",
          role: "read",
          capability: "requirement.load",
          objects: ["Work"],
        },
        {
          call_order: 2,
          name: "GoHire_System",
          kind: "external_api",
          role: "execute",
          capability: "jd.generate",
          objects: ["Work"],
        },
        {
          call_order: 3,
          name: "RAAS_System",
          kind: "database",
          role: "write",
          capability: "entity.write",
          objects: ["Work"],
        },
        {
          call_order: 4,
          name: "Allmeta_Ontology_System",
          kind: "graph_db",
          role: "write",
          capability: "instance.mirror",
          objects: ["Work"],
        },
      ],
    };
    const realTools = [
      {
        name: "facts.query",
        operation: "read" as const,
        effectScope: "external" as const,
        sandboxPolicy: "live_external" as const,
        capabilities: [
          {
            systems: ["RAAS_System"],
            kinds: ["database"],
            roles: ["read"],
            operations: ["requirement.load"],
            objectTypes: ["Work"],
          },
        ],
      },
      {
        name: "generateJdApi",
        operation: "compute" as const,
        effectScope: "external" as const,
        sandboxPolicy: "live_external" as const,
        capabilities: [
          {
            systems: ["GoHire_System"],
            kinds: ["external_api"],
            roles: ["execute"],
            operations: ["jd.generate"],
            objectTypes: ["Work"],
          },
        ],
      },
      {
        name: "entities.write",
        operation: "write" as const,
        effectScope: "external" as const,
        sandboxPolicy: "requires_attempt_grant" as const,
        capabilities: [
          {
            systems: ["RAAS_System"],
            kinds: ["database"],
            roles: ["write"],
            operations: ["entity.write"],
            objectTypes: ["Work"],
          },
        ],
      },
      {
        name: "ontology.writeInstance",
        operation: "write" as const,
        effectScope: "external" as const,
        sandboxPolicy: "requires_attempt_grant" as const,
        capabilities: [
          {
            systems: ["Allmeta_Ontology_System"],
            kinds: ["graph_db"],
            roles: ["write"],
            operations: ["instance.mirror"],
            objectTypes: ["Work"],
          },
        ],
      },
    ];
    const ctx = context(ontology);
    ctx.ports.tools!.list = async () => [];
    ctx.ports.toolRegistry = { list: async () => realTools };

    await readOntology.execute({}, ctx);
    const result = await designAgent.execute(
      {
        action: "doWork",
        system_prompt:
          "按需求读取、生成、权威写入与本体镜像的完整顺序执行。",
        decision_logic: "四个边界全部成功才 emit WORK_DONE；任一步失败即终止。",
        plan: action.tool_use.map((tool, index) => ({
          stepId: `boundary-${index + 1}`,
          kind: "tool",
          tool,
          idempotencyKeyFrom: "work_id",
          onError: "terminal",
        })),
      },
      ctx,
    );

    expect(result.ok, result.summary).toBe(true);
    expect(ctx.specs[0]?.tools).toEqual([
      "facts.query",
      "generateJdApi",
      "entities.write",
      "ontology.writeInstance",
    ]);
    expect(ctx.specs[0]?.plan?.map((step) => step.tool)).toEqual([
      "facts.query",
      "generateJdApi",
      "entities.write",
      "ontology.writeInstance",
    ]);
  });

  it("does not let action-level integration readiness erase unprojected live rule-check source tools", async () => {
    const ontology = validOntology();
    const action = ontology.actions[0]!;
    action.name = "ruleCheckForMatchResume";
    ontology.events[1]!.payload.source_action = action.name;
    action.tool_use = [
      "loadRaasRuleContext",
      "reasoning.evaluateRules",
      "persistRuleCheckAudit",
      "ontology.fetchActionRules",
      "persistRaasEntities",
    ];
    action.action_steps = action.tool_use.map((tool, index) => ({
      step_id: `rule-step-${index + 1}`,
      name: `ruleStep${index + 1}`,
      type: "tool",
      object_type: "tool",
      tool,
    }));
    action.integration = {
      systems: [
        {
          name: "RAAS_System",
          kind: "database",
          role: "read",
          capability: "rule_context.load",
          objects: ["Work"],
        },
        {
          name: "Allmeta_Ontology_System",
          kind: "graph_db",
          role: "read",
          capability: "rules.select + graph.verify",
          objects: ["Work"],
        },
        {
          name: "LLM_Gateway",
          kind: "llm",
          role: "execute",
          capability: "rules.judge",
          objects: ["Work"],
        },
        {
          name: "RAAS_System",
          kind: "database",
          role: "write",
          capability: "cmr.write_fail",
          objects: ["Work"],
        },
        {
          name: "Allmeta_Ontology_System",
          kind: "graph_db",
          role: "write",
          capability: "cmr.mirror",
          objects: ["Work"],
        },
      ],
    };
    const ctx = context(ontology);
    ctx.ports.tools!.list = async () => [];
    ctx.ports.integrationCapabilities = {
      list: async () => [
        {
          id: "agent-runtime.reason",
          status: "available",
          capabilities: [
            {
              systems: ["LLM Gateway"],
              kinds: ["llm"],
              roles: ["execute"],
              operations: ["rules.judge"],
              objectTypes: ["*"],
            },
          ],
        },
      ],
    };
    const allmetaRead = {
      systems: ["Allmeta_Ontology_System"],
      kinds: ["graph_db"],
      roles: ["read"],
      operations: ["rules.select", "graph.verify"],
      objectTypes: ["Work"],
      probeRequired: true,
    };
    ctx.ports.toolRegistry = {
      list: async () => [
        {
          name: "reasoning.evaluateRules",
          operation: "compute",
          effectScope: "external",
          sandboxPolicy: "live_external",
          capabilities: [allmetaRead],
          probeStatus: "required",
          verifiedDefinitionHashes: [],
        },
        {
          // Deliberately tied with the exact Ontology declaration above. The
          // broad discovery pass cannot choose between these two by score.
          name: "ontology.query",
          operation: "read",
          effectScope: "external",
          sandboxPolicy: "live_external",
          capabilities: [allmetaRead],
          probeStatus: "required",
          verifiedDefinitionHashes: [],
        },
        {
          name: "persistRuleCheckAudit",
          operation: "write",
          effectScope: "external",
          sandboxPolicy: "requires_attempt_grant",
          probeStatus: "required",
          verifiedDefinitionHashes: [],
        },
        {
          name: "ontology.fetchActionRules",
          operation: "read",
          effectScope: "external",
          sandboxPolicy: "live_external",
          capabilities: [
            {
              systems: ["Allmeta_Ontology_System"],
              kinds: ["rulebase"],
              roles: ["read"],
              operations: ["rules.select"],
              objectTypes: ["Rule"],
              probeRequired: true,
            },
          ],
          probeStatus: "required",
          verifiedDefinitionHashes: [],
        },
        {
          name: "facts.query",
          operation: "read",
          effectScope: "external",
          sandboxPolicy: "live_external",
          capabilities: [
            {
              systems: ["*"],
              systemConfigKey: "system_name",
              kinds: ["database"],
              roles: ["read"],
              operations: ["rule_context.load"],
              objectTypes: ["*"],
              probeRequired: true,
            },
          ],
          probeStatus: "required",
          verifiedDefinitionHashes: [],
        },
        {
          name: "entities.write",
          operation: "write",
          effectScope: "external",
          sandboxPolicy: "requires_attempt_grant",
          capabilities: [
            {
              systems: ["*"],
              systemConfigKey: "system_name",
              kinds: ["database"],
              roles: ["write"],
              operations: ["cmr.write_fail"],
              objectTypes: ["*"],
              probeRequired: true,
            },
          ],
          probeStatus: "required",
          verifiedDefinitionHashes: [],
        },
        {
          name: "ontology.writeInstance",
          operation: "write",
          effectScope: "external",
          sandboxPolicy: "requires_attempt_grant",
          capabilities: [
            {
              systems: ["Allmeta_Ontology_System"],
              kinds: ["graph_db"],
              roles: ["write"],
              operations: ["cmr.mirror"],
              objectTypes: ["*"],
              probeRequired: true,
            },
          ],
          probeStatus: "required",
          verifiedDefinitionHashes: [],
        },
      ],
    };

    await readOntology.execute({}, ctx);
    const readiness = await inspectActionReadiness.execute(
      { action: action.name },
      ctx,
    );

    expect(readiness.output).toMatchObject({
      authoringReady: false,
      sandboxReady: false,
      promotionReady: false,
      integrationGate: {
        ready: false,
        integrationBackedSubstitution: true,
        missingDeclaredTools: [
          "loadRaasRuleContext",
          "persistRaasEntities",
        ],
        exactDeclaredToolGaps: [
          "loadRaasRuleContext",
          "persistRaasEntities",
        ],
        identityGaps: [],
        policyGaps: [],
        effectiveTools: expect.arrayContaining([
          "reasoning.evaluateRules",
          "persistRuleCheckAudit",
          "ontology.fetchActionRules",
          "facts.query",
          "entities.write",
          "ontology.writeInstance",
        ]),
      },
    });
    expect((readiness.output as { next?: string }).next).toBeUndefined();
  });

  it("lets design_agent use an exact declared tool to resolve an otherwise tied integration", async () => {
    const ontology = validOntology();
    const action = ontology.actions[0]!;
    action.tool_use = ["legacyVendorReader", "vendor.alpha"];
    action.action_steps = [
      {
        step_id: "fetch",
        name: "fetch",
        type: "tool",
        object_type: "tool",
        tool: "legacyVendorReader",
      },
    ];
    action.integration = {
      systems: [
        {
          name: "Vendor",
          kind: "external_api",
          role: "reads",
          capability: "GET /lookup",
          objects: ["Work"],
        },
      ],
    };
    const capability = {
      systems: ["Vendor"],
      kinds: ["external_api"],
      roles: ["reads"],
      operations: ["lookup"],
      objectTypes: ["Work"],
      probeRequired: true,
    };
    const ctx = context(ontology);
    ctx.ports.tools!.list = async () => [];
    ctx.ports.toolRegistry = {
      list: async () => [
        {
          name: "vendor.alpha",
          operation: "read",
          effectScope: "external",
          sandboxPolicy: "live_external",
          capabilities: [capability],
          probeStatus: "required",
          verifiedDefinitionHashes: [],
        },
        {
          name: "vendor.beta",
          operation: "read",
          effectScope: "external",
          sandboxPolicy: "live_external",
          capabilities: [capability],
          probeStatus: "required",
          verifiedDefinitionHashes: [],
        },
      ],
    };

    await readOntology.execute({}, ctx);
    const result = await designAgent.execute(
      {
        action: "doWork",
        system_prompt: "使用 Ontology 明确声明的 Vendor 工具读取 Work。",
        decision_logic: "读取成功 emit WORK_DONE；失败终止。",
        tools: ["vendor.alpha"],
        plan: [
          {
            stepId: "fetch",
            kind: "tool",
            tool: "vendor.alpha",
            idempotencyKeyFrom: "work_id",
            onError: "terminal",
          },
        ],
      },
      ctx,
    );

    expect(result).toMatchObject({
      ok: true,
      output: {
        tools: ["vendor.alpha"],
        readiness: {
          authoringReady: true,
          sandboxReady: false,
          promotionReady: false,
        },
      },
    });
    expect(ctx.specs[0]?.unresolvedTools).toContain("legacyVendorReader");
    expect(ctx.specs[0]?.integrationBindings).toEqual([
      expect.objectContaining({
        toolName: "vendor.alpha",
        status: "needs_probe",
      }),
    ]);
  });

  it("uses a server-issued requirement selection only for the exact Ontology hash", async () => {
    const ontology = validOntology();
    const action = ontology.actions[0]!;
    action.action_steps = [
      {
        step_id: "fetch",
        name: "fetch",
        type: "tool",
        object_type: "tool",
      },
    ];
    const capability = {
      systems: ["Vendor"],
      kinds: ["external_api"],
      roles: ["reads"],
      operations: ["lookup"],
      objectTypes: ["Work"],
    };
    const registryTools = ["vendor.alpha", "vendor.beta"].map((name) => ({
      name,
      operation: "read" as const,
      effectScope: "external" as const,
      sandboxPolicy: "live_external" as const,
      capabilities: [capability],
      probeStatus: "verified" as const,
    }));
    const ctx = context(ontology);
    ctx.ports.tools!.list = async () => [];
    ctx.ports.toolRegistry = { list: async () => registryTools };

    await readOntology.execute({}, ctx);
    const readinessChoice = await inspectActionReadiness.execute(
      { action: "doWork" },
      ctx,
    );
    expect(readinessChoice).toMatchObject({
      ok: false,
      output: {
        next: "ask_user",
        reason: "ambiguous_integration_binding",
        action: "doWork",
        options: [
          expect.objectContaining({
            label: "a1:integration:1 → vendor.alpha",
          }),
          expect.objectContaining({
            label: "a1:integration:1 → vendor.beta",
          }),
        ],
      },
    });
    expect(ctx.pendingIntegrationSelectionAsk).toMatchObject({
      actionName: "doWork",
      options: [
        expect.objectContaining({
          requirementId: "a1:integration:1",
          bindingId: "vendor.alpha",
        }),
        expect.objectContaining({
          requirementId: "a1:integration:1",
          bindingId: "vendor.beta",
        }),
      ],
    });
    // The readiness card does not choose on the user's behalf. Clear this
    // pending card so the direct design path below proves it independently
    // mints the same governed choice.
    ctx.pendingIntegrationSelectionAsk = undefined;
    const designArgs = {
      action: "doWork",
      system_prompt: "使用用户明确选择的 Vendor 读取工具完成 Work 查询。",
      decision_logic: "查询成功后 emit WORK_DONE；失败终止。",
      plan: [
        {
          stepId: "fetch",
          kind: "tool",
          tool: "vendor.beta",
          idempotencyKeyFrom: "work_id",
          onError: "terminal",
        },
      ],
    };
    const blocked = await designAgent.execute(designArgs, ctx);
    expect(blocked.ok).toBe(false);
    expect(blocked.output).toMatchObject({
      next: "ask_user",
      reason: "integration_selection_required",
      candidates: expect.arrayContaining([
        expect.objectContaining({
          requirementId: "a1:integration:1",
          id: "vendor.alpha",
        }),
        expect.objectContaining({
          requirementId: "a1:integration:1",
          id: "vendor.beta",
        }),
      ]),
      options: expect.any(Array),
    });
    const pending = ctx.pendingIntegrationSelectionAsk!;
    const beta = pending.options.find(
      (option) => option.bindingId === "vendor.beta",
    )!;
    expect(
      consumeIntegrationSelectionAnswer(pending, "请用 vendor.beta", {
        selectedAt: 1,
      }),
    ).toBeNull();
    const selection = consumeIntegrationSelectionAnswer(
      pending,
      beta.token,
      { interactionId: "hitl-binding", actor: "fde", selectedAt: 1 },
    );
    expect(selection).toMatchObject({
      ontologyHash: ontologyContentHash(ctx.ontology!),
      actionName: "doWork",
      requirementId: "a1:integration:1",
      bindingKind: "tool",
      bindingId: "vendor.beta",
    });
    ctx.integrationSelections = [selection!];
    ctx.pendingIntegrationSelectionAsk = undefined;

    const selected = await designAgent.execute(designArgs, ctx);
    expect(selected.ok, selected.summary).toBe(true);
    expect(selected.output).toMatchObject({ tools: ["vendor.beta"] });

    ctx.specs = [];
    ctx.ontology!.actions[0]!.description = "Ontology contract drift";
    const drifted = await designAgent.execute(designArgs, ctx);
    expect(drifted.ok).toBe(false);
    expect(drifted.output).toMatchObject({
      next: "ask_user",
      reason: "integration_selection_required",
    });
  });

  it("keeps equal candidates distinct for each integration requirement id", async () => {
    const ontology = validOntology();
    const action = ontology.actions[0]!;
    const first = (
      action.integration!.systems as Array<Record<string, unknown>>
    )[0]!;
    action.integration = {
      systems: [first, { ...first }],
    };
    const capability = {
      systems: ["Vendor"],
      kinds: ["external_api"],
      roles: ["reads"],
      operations: ["lookup"],
      objectTypes: ["Work"],
    };
    const ctx = context(ontology);
    ctx.ports.tools!.list = async () => [];
    ctx.ports.toolRegistry = {
      list: async () =>
        ["vendor.alpha", "vendor.beta"].map((name) => ({
          name,
          operation: "read" as const,
          effectScope: "external" as const,
          sandboxPolicy: "live_external" as const,
          capabilities: [capability],
        })),
    };

    await readOntology.execute({}, ctx);
    const blocked = await designAgent.execute(
      {
        action: "doWork",
        system_prompt: "通过明确选择的 Vendor 读取边界完成查询。",
        decision_logic: "成功 emit WORK_DONE；失败终止。",
      },
      ctx,
    );
    const candidates = (
      blocked.output as {
        candidates: Array<{ requirementId: string; id: string }>;
      }
    ).candidates;
    expect(candidates).toEqual(
      expect.arrayContaining([
        { requirementId: "a1:integration:1", id: "vendor.alpha", kind: "tool", status: "same_top_score" },
        { requirementId: "a1:integration:1", id: "vendor.beta", kind: "tool", status: "same_top_score" },
        { requirementId: "a1:integration:2", id: "vendor.alpha", kind: "tool", status: "same_top_score" },
        { requirementId: "a1:integration:2", id: "vendor.beta", kind: "tool", status: "same_top_score" },
      ]),
    );
    expect(candidates).toHaveLength(4);
    expect(ctx.pendingIntegrationSelectionAsk?.options).toHaveLength(4);
  });

  it("fails closed on a missing action_steps tool when no structured integration proves a substitute", async () => {
    const ontology = validOntology();
    const action = ontology.actions[0]!;
    action.tool_use = [];
    action.integration = { systems: [] };
    action.action_steps = [
      {
        step_id: "fetch",
        name: "fetch",
        type: "tool",
        object_type: "tool",
        tool: "missing.exact.reader",
      },
    ];
    const ctx = context(ontology);
    ctx.ports.tools!.list = async () => [];

    await readOntology.execute({}, ctx);
    const readiness = await inspectActionReadiness.execute(
      { action: "doWork" },
      ctx,
    );
    expect(readiness.output).toMatchObject({
      authoringReady: false,
      integrationGate: {
        integrationBackedSubstitution: false,
        exactDeclaredToolGaps: ["missing.exact.reader"],
      },
    });

    const result = await designAgent.execute(
      {
        action: "doWork",
        system_prompt: "按 Ontology 的精确工具契约执行。",
        decision_logic: "成功 emit WORK_DONE；失败终止。",
      },
      ctx,
    );
    expect(result).toMatchObject({
      ok: false,
      output: {
        reason: "ontology_execution_tool_missing",
        missing: ["missing.exact.reader"],
      },
    });
  });

  it("authors a pure logic function without inventing a tool or provisioning gap", async () => {
    const ontology = validOntology();
    const action = ontology.actions[0]!;
    action.action_steps = [];
    delete action.integration;
    action.tool_use = [];
    const ctx = context(ontology);
    await readOntology.execute({}, ctx);

    const result = await designAgent.execute(
      {
        action: "doWork",
        system_prompt: "只按输入契约做确定性字段归一化，不访问外部系统。",
        decision_logic:
          "输入有效时把归一化结果写入 payload 并 emit WORK_DONE；输入无效时终止。",
      },
      ctx,
    );

    expect(result).toMatchObject({
      ok: true,
      output: {
        tools: [],
        provisioning: { needed: false },
      },
    });
    expect(result.summary).not.toContain("没绑到任何工具");
    expect(result.summary).not.toContain("先 ask_user");
    expect(ctx.specs[0]).toMatchObject({
      tools: [],
      integrationRequirements: [],
      integrationBindings: [],
    });
  });

  it("allows authoring but reports a sandbox blocker when a selected integration lacks probe evidence", async () => {
    const ontology = validOntology();
    ontology.actions[0]!.tool_use = ["vendor.unprobed"];
    const ctx = context(ontology);
    ctx.ports.tools!.list = async () => [];
    ctx.ports.toolRegistry = {
      list: async () => [
        {
          name: "vendor.unprobed",
          operation: "read",
          effectScope: "external",
          sandboxPolicy: "live_external",
          capabilities: [
            {
              systems: ["Vendor"],
              kinds: ["external_api"],
              roles: ["reads"],
              operations: ["lookup"],
              objectTypes: ["Work"],
              probeRequired: true,
            },
          ],
          probeStatus: "required",
          definitionHash: "sha256:unverified",
          verifiedDefinitionHashes: [],
        },
      ],
    };
    await readOntology.execute({}, ctx);

    const readiness = await inspectActionReadiness.execute(
      { action: "doWork" },
      ctx,
    );
    expect(readiness.output).toMatchObject({
      authoringReady: true,
      sandboxReady: false,
      promotionReady: false,
    });
    expect((readiness.output as { next?: string }).next).toBeUndefined();

    const result = await designAgent.execute(
      {
        action: "doWork",
        system_prompt: "按契约读取真实 Vendor 数据。",
        decision_logic: "成功 emit WORK_DONE；失败终止。",
        plan: [
          {
            stepId: "fetch",
            kind: "tool",
            tool: "vendor.unprobed",
            idempotencyKeyFrom: "work_id",
            onError: "terminal",
          },
        ],
      },
      ctx,
    );

    expect(result).toMatchObject({
      ok: true,
      output: {
        readiness: {
          schema: "agent-factory-execution-readiness/v1",
          authoringReady: true,
          sandboxReady: false,
          promotionReady: false,
          probeGaps: [{ tool: "vendor.unprobed" }],
          externalApis: [
            expect.objectContaining({
              tool: "vendor.unprobed",
              systems: ["Vendor"],
              sandboxReady: false,
              promotionReady: false,
            }),
          ],
        },
      },
    });
    expect(result.summary).toContain("草稿已生成");
    expect(ctx.specs).toHaveLength(1);
    expect(ctx.specs[0]?.generatedCode).toContain("export");
    expect(ctx.specs[0]?.executionReadiness).toMatchObject({
      authoringReady: true,
      sandboxReady: false,
      promotionReady: false,
    });
    expect(ctx.specs[0]?.integrationBindings?.[0]).toMatchObject({
      toolName: "vendor.unprobed",
      status: "needs_probe",
    });
  });

  it("reports signed-fixture as sandbox-ready but never promotion-ready without an exact live probe", async () => {
    const ontology = validOntology();
    ontology.actions[0]!.tool_use = ["vendor.fixture"];
    const catalogDefinition = {
      name: "vendor.fixture",
      category: "vendor",
      sourcePath: "test/vendor-fixture.ts",
      sideEffect: "read" as const,
      operation: "read" as const,
      effectScope: "external" as const,
      sandboxPolicy: "live_external" as const,
      argsSchema: { work_id: { type: "string", required: true } },
      returnsSchema: { result: { type: "string", required: true } },
      capabilities: [
        {
          systems: ["Vendor"],
          kinds: ["external_api"],
          roles: ["reads"],
          operations: ["lookup"],
          objectTypes: ["Work"],
          probeRequired: true,
        },
      ],
    };
    const definitionHash = catalogToolDefinitionHash(
      catalogDefinition,
      {},
      process.env,
    );
    const realTool = {
      name: "vendor.fixture",
      sideEffect: "read" as const,
      operation: "read" as const,
      effectScope: "external" as const,
      sandboxPolicy: "live_external" as const,
      capabilities: catalogDefinition.capabilities,
      probeStatus: "verified" as const,
      definitionHash,
      verifiedDefinitionHashes: [definitionHash],
      productionVerifiedDefinitionHashes: [] as string[],
      probeEvidenceMode: "signed-fixture" as const,
      catalogDefinition,
    };
    const ctx = context(ontology);
    ctx.ports.tools!.list = async () => [];
    ctx.ports.toolRegistry = { list: async () => [realTool] };
    await readOntology.execute({}, ctx);

    const sandboxOnly = await inspectActionReadiness.execute(
      { action: "doWork" },
      ctx,
    );
    expect(sandboxOnly.output).toMatchObject({
      authoringReady: true,
      sandboxReady: true,
      promotionReady: false,
      probeGate: {
        sandboxReady: true,
        promotionReady: false,
        tools: [
          {
            tool: "vendor.fixture",
            evidenceMode: "signed-fixture",
            sandboxReady: true,
            promotionReady: false,
          },
        ],
      },
    });

    realTool.productionVerifiedDefinitionHashes.push(definitionHash);
    realTool.probeEvidenceMode = "live-probe" as never;
    const liveReady = await inspectActionReadiness.execute(
      { action: "doWork" },
      ctx,
    );
    expect(liveReady.output).toMatchObject({
      sandboxReady: true,
      promotionReady: true,
      probeGate: { sandboxReady: true, promotionReady: true },
    });
  });

  it("auto-selects the only exact capability candidate when both explicit tool selections are empty", async () => {
    const ctx = context(validOntology());
    await readOntology.execute({}, ctx);
    const result = await designAgent.execute(
      {
        action: "doWork",
        system_prompt: "按契约读取真实 Vendor 数据。",
        decision_logic: "成功 emit WORK_DONE；失败终止。",
        plan: [
          {
            stepId: "fetch",
            kind: "tool",
            tool: "vendor.lookup",
            idempotencyKeyFrom: "work_id",
            onError: "terminal",
          },
        ],
      },
      ctx,
    );
    expect(result).toMatchObject({
      ok: true,
      output: {
        tools: ["vendor.lookup"],
        toolSelectionSource: "unique_capability_binding",
      },
    });
    expect(ctx.specs).toHaveLength(1);
  });

  it("uses Ontology action.tool_use, and only that declaration, when design tools are empty", async () => {
    const ontology = validOntology();
    ontology.actions[0]!.tool_use = ["vendor.lookup"];
    const ctx = context(ontology);
    await readOntology.execute({}, ctx);
    const result = await designAgent.execute(
      {
        action: "doWork",
        system_prompt: "按契约读取真实 Vendor 数据。",
        decision_logic: "成功 emit WORK_DONE；失败终止。",
        plan: [
          {
            stepId: "fetch",
            kind: "tool",
            tool: "vendor.lookup",
            idempotencyKeyFrom: "work_id",
            onError: "terminal",
          },
        ],
      },
      ctx,
    );
    expect(result.ok).toBe(true);
    expect(result.output).toMatchObject({
      tools: ["vendor.lookup"],
      toolSelectionSource: "ontology.action.tool_use",
    });
    expect(ctx.specs[0]?.tools).toEqual(["vendor.lookup"]);
  });

  // #TOOLUSE-AS-SUGGESTION — an ontology that names a tool this tenant does NOT grant must not hard
  // block: tool_use is a suggestion, integration.systems[] is authoritative, and discovery binds the
  // granted transport for the requirement. This is what makes the factory adapt to any ontology
  // (e.g. Agents-generation naming legacy RAAS tools that resolve to facts.query/entities.write).
  it("substitutes the discovered granted transport when tool_use names an UNGRANTED tool, and reports the drop", async () => {
    const ontology = validOntology();
    // The author suggested a tool that doesn't exist in this tenant's registry; the action's real
    // requirement (Vendor/read) IS covered by the granted vendor.lookup.
    ontology.actions[0]!.tool_use = ["legacyVendorReader"];
    const ctx = context(ontology);
    await readOntology.execute({}, ctx);
    const result = await designAgent.execute(
      {
        action: "doWork",
        system_prompt: "按契约读取真实 Vendor 数据。",
        decision_logic: "成功 emit WORK_DONE；失败终止。",
        plan: [
          {
            stepId: "fetch",
            kind: "tool",
            tool: "vendor.lookup",
            idempotencyKeyFrom: "work_id",
            onError: "terminal",
          },
        ],
      },
      ctx,
    );
    expect(result.ok).toBe(true); // NOT tool_execution_policy_missing
    // the executable set is the discovered granted transport, not the ungranted suggestion
    expect(ctx.specs[0]?.tools).toEqual(["vendor.lookup"]);
    // the ungranted suggestion is surfaced honestly, never silently swallowed
    expect(ctx.specs[0]?.unresolvedTools).toContain("legacyVendorReader");
    expect(
      String(
        (result.output as { toolSelectionSource?: string }).toolSelectionSource,
      ),
    ).toContain("integration_binding");
  });

  // #TOOLUSE-ECHO — a model that COPIES the ontology's tool_use into design_agent.tools has not made
  // a deliberate novel choice; the ungranted names substitute exactly like ontology suggestions.
  // (Live regression: fleet members echoed tool_use every run → the same templated
  // tool_execution_policy_missing ask re-parked every run.) A name the model invents BEYOND the
  // ontology still hard-asks.
  it("explicit tools ECHOING ungranted tool_use names substitute instead of hard-asking; a novel invented name still asks", async () => {
    const ontology = validOntology();
    ontology.actions[0]!.tool_use = ["legacyVendorReader"];
    const ctx = context(ontology);
    await readOntology.execute({}, ctx);
    const echoed = await designAgent.execute(
      {
        action: "doWork",
        system_prompt: "按契约读取真实 Vendor 数据。",
        decision_logic: "成功 emit WORK_DONE；失败终止。",
        tools: ["legacyVendorReader"], // echo of tool_use, NOT a novel invention
        plan: [
          {
            stepId: "fetch",
            kind: "tool",
            tool: "vendor.lookup",
            idempotencyKeyFrom: "work_id",
            onError: "terminal",
          },
        ],
      },
      ctx,
    );
    expect(echoed.ok).toBe(true);
    expect((echoed.output as { reason?: string }).reason).not.toBe(
      "tool_execution_policy_missing",
    );
    expect(ctx.specs[0]?.tools).toEqual(["vendor.lookup"]); // substituted granted transport
    expect(ctx.specs[0]?.unresolvedTools).toContain("legacyVendorReader");

    const invented = await designAgent.execute(
      {
        action: "doWork",
        system_prompt: "按契约读取真实 Vendor 数据。",
        decision_logic: "成功 emit WORK_DONE；失败终止。",
        // MIXED pick: an echoed ontology name AND a novel invention — the ask must name ONLY the invention.
        tools: ["legacyVendorReader", "magicDataFetcher9000"],
      },
      ctx,
    );
    expect(invented.ok).toBe(false);
    expect((invented.output as { reason?: string }).reason).toBe(
      "tool_execution_policy_missing",
    );
    expect(String(invented.summary)).toContain("magicDataFetcher9000");
    expect(String(invented.summary)).not.toContain("legacyVendorReader"); // asks ONLY about the novel name
  });

  // A source-only tool_use symbol is not executable evidence. An action-level
  // integration match cannot clear it unless the final per-symbol projection
  // contains that exact source name.
  it("readiness keeps an unprojected tool_use source symbol blocked even when another transport covers the action", async () => {
    const ontology = validOntology();
    ontology.actions[0]!.tool_use = ["legacyVendorReader"];
    const ctx = context(ontology);
    await readOntology.execute({}, ctx);
    const result = await inspectActionReadiness.execute(
      { action: "doWork" },
      ctx,
    );
    expect(result.ok).toBe(true);
    const report =
      (result.output as { report?: Record<string, unknown> }).report ??
      (result.output as Record<string, unknown>);
    const gate =
      (report as { integrationGate?: Record<string, unknown> })
        .integrationGate ?? {};
    expect((report as { authoringReady?: boolean }).authoringReady).toBe(false);
    expect(gate.missingDeclaredTools).toContain("legacyVendorReader");
    expect(gate.exactDeclaredToolGaps).toContain("legacyVendorReader");
    // The discovered transport stays visible without becoming blanket
    // substitution authority for the source-only symbol.
    expect(gate.effectiveTools).toContain("vendor.lookup");
    expect((result.output as { next?: string }).next).toBeUndefined();
  });

  // #ASK-PARK dedup — a missing rule-tool SELECTION is design_agent's own ask surface; the
  // readiness inspector must report it as designer guidance, NOT force another ask_user park
  // (live regression: the run re-parked on a question the operator had just answered).
  it("rule-tool-only gap: inspector reports not-ready WITHOUT force-parking on ask_user", async () => {
    const ontology = validOntology();
    // Step-level rule reference makes the action a rule gate; its integration requirement is
    // still fully covered by the granted vendor.lookup, and NO granted tool reads a rulebase.
    // The rule itself RESOLVES (canonical id exists) — the only gap left is the tool selection.
    (ontology as { rules: unknown[] }).rules = [
      { id: "r-1", name: "工作校验规则", description: "结果必须非空" },
    ];
    ontology.actions[0]!.action_steps = [
      { id: "fetch", name: "fetch", type: "tool", rules: [{ id: "r-1" }] },
    ] as never;
    const ctx = context(ontology);
    await readOntology.execute({}, ctx);
    const result = await inspectActionReadiness.execute(
      { action: "doWork" },
      ctx,
    );
    expect(result.ok).toBe(true);
    const out = result.output as {
      authoringReady?: boolean;
      next?: string;
      integrationGate?: { ruleToolSatisfied?: boolean };
    };
    expect(out.authoringReady).toBe(false); // a bare design_agent call would still ask — honest
    expect(out.integrationGate?.ruleToolSatisfied).toBe(false);
    expect(out.next).toBeUndefined(); // but the INSPECTOR must not park the run itself
    expect(String(result.summary)).toContain("design_agent");
  });

  it("adds the sole capability-declared rule reader even when other integrations are discovered", async () => {
    const ontology = validOntology();
    ontology.rules = [
      { id: "r-1", name: "工作校验规则", description: "结果必须非空" },
    ];
    ontology.actions[0]!.action_steps = [
      {
        id: "fetch",
        name: "fetch",
        type: "tool",
        rules: [{ id: "r-1" }],
      },
    ] as never;
    const ctx = context(ontology);
    ctx.ports.toolRegistry = {
      list: async () => [
        {
          name: "ontology.rules.read",
          operation: "read",
          effectScope: "external",
          sandboxPolicy: "live_external",
          capabilities: [
            {
              systems: ["Policy Store"],
              kinds: ["rulebase"],
              roles: ["reads"],
              objectTypes: ["Rule"],
            },
          ],
        },
      ],
    };

    await readOntology.execute({}, ctx);
    const result = await inspectActionReadiness.execute(
      { action: "doWork" },
      ctx,
    );
    const out = result.output as {
      authoringReady?: boolean;
      integrationGate?: {
        effectiveTools?: string[];
        ruleToolSatisfied?: boolean;
      };
    };

    expect(out.authoringReady).toBe(true);
    expect(out.integrationGate?.effectiveTools).toEqual(
      expect.arrayContaining(["vendor.lookup", "ontology.rules.read"]),
    );
    expect(out.integrationGate?.ruleToolSatisfied).toBe(true);
  });

  it("does not let a sole rule-reader candidate bypass execution-policy authoring gates", async () => {
    const ontology = validOntology();
    ontology.rules = [
      { id: "r-1", name: "工作校验规则", description: "结果必须非空" },
    ];
    ontology.actions[0]!.action_steps = [
      {
        id: "fetch",
        name: "fetch",
        type: "tool",
        rules: [{ id: "r-1" }],
      },
    ] as never;
    const unsafeReader = {
      name: "ontology.rules.unsafe",
      capabilities: [
        {
          systems: ["Policy Store"],
          kinds: ["rulebase"],
          roles: ["reads"],
          objectTypes: ["Rule"],
        },
      ],
    };
    const ctx = context(ontology);
    ctx.ports.toolRegistry = { list: async () => [unsafeReader as never] };

    await readOntology.execute({}, ctx);
    const readiness = await inspectActionReadiness.execute(
      { action: "doWork" },
      ctx,
    );
    expect(readiness.output).toMatchObject({
      authoringReady: false,
      next: "ask_user",
      missing: expect.arrayContaining(["tool_execution_policies"]),
      integrationGate: {
        ruleToolSatisfied: true,
        policyGaps: ["ontology.rules.unsafe"],
      },
    });

    const design = await designAgent.execute(
      {
        action: "doWork",
        system_prompt: "读取当前规则后处理工作。",
        decision_logic: "通过后 emit WORK_DONE，否则终止。",
      },
      ctx,
    );
    expect(design).toMatchObject({
      ok: false,
      output: {
        next: "ask_user",
        reason: "tool_execution_policy_missing",
        missing: ["ontology.rules.unsafe"],
      },
    });
  });

  it("allows drafting a uniquely matched default-off integration while execution stays fail-closed", async () => {
    const ontology = validOntology();
    ontology.actions[0]!.action_steps = [
      {
        // Live Allmeta shape: action_steps[].order is zero-based while
        // integration.systems[].call_order keeps the one-based source value.
        order: 0,
        step_id: "optional_vendor_check",
        name: "optionalVendorCheck",
        type: "tool",
        condition: "VENDOR_CHECK_ENABLED=1 (默认关，关闭时跳过整步)",
      },
    ] as never;
    ontology.actions[0]!.integration = {
      systems: [
        {
          call_order: 1,
          name: "Optional Vendor",
          kind: "external_api",
          role: "execute",
          capability: "optional enrichment",
          objects: ["Work"],
        },
      ],
    };
    const ctx = context(ontology);
    ctx.ports.tools!.list = async () => [];

    await readOntology.execute({}, ctx);
    const result = await inspectActionReadiness.execute(
      { action: "doWork" },
      ctx,
    );
    const out = result.output as {
      authoringReady?: boolean;
      sandboxReady?: boolean;
      promotionReady?: boolean;
      integrationGate?: {
        identityGaps?: unknown[];
        authoringOptionalGaps?: Array<{
          requirement: {
            authoringOptional?: {
              source?: string;
              stepId?: string;
            };
          };
        }>;
      };
    };

    expect(out.authoringReady).toBe(true);
    expect(out.sandboxReady).toBe(false);
    expect(out.promotionReady).toBe(false);
    expect(out.integrationGate?.identityGaps).toEqual([]);
    expect(out.integrationGate?.authoringOptionalGaps).toEqual([
      expect.objectContaining({
        requirement: expect.objectContaining({
          authoringOptional: expect.objectContaining({
            source: "action_step.condition",
            stepId: "optional_vendor_check",
          }),
        }),
      }),
    ]);
  });

  it("keeps a system-referenced dark-launch path authoring-optional when call_order is not the Action step index", async () => {
    const ontology = validOntology();
    ontology.actions[0]!.action_steps = [
      {
        order: 0,
        step_id: "read_resume",
        name: "readResume",
        type: "tool",
        condition: "always",
      },
      {
        order: 7,
        step_id: "optional_ownership_lock_check",
        name: "optionalOwnershipLockCheck",
        type: "logic",
        condition:
          "LOCK_CHECK_ENABLED=1 (default off); only enforce when LOCK_CHECK_ENFORCE=1",
        description:
          "Read lock facts from Internal_Recruitment_System when the dark-launch flag is enabled.",
      },
    ] as never;
    ontology.actions[0]!.integration = {
      systems: [
        {
          // Integration order describes external-call sequence, not the
          // physical index in action_steps.
          call_order: 1,
          name: "Internal_Recruitment_System",
          kind: "external_api",
          role: "execute",
          capability: "read-lock-facts",
          objects: ["Work"],
        },
      ],
    };
    const ctx = context(ontology);
    ctx.ports.tools!.list = async () => [];
    ctx.ports.toolRegistry = { list: async () => [] };

    await readOntology.execute({}, ctx);
    const result = await inspectActionReadiness.execute(
      { action: "doWork" },
      ctx,
    );
    const out = result.output as {
      authoringReady?: boolean;
      sandboxReady?: boolean;
      promotionReady?: boolean;
      next?: string;
      integrationGate?: {
        identityGaps?: unknown[];
        authoringOptionalGaps?: Array<{
          requirement: {
            authoringOptional?: {
              source?: string;
              stepId?: string;
              evidence?: string;
            };
          };
        }>;
      };
    };

    expect(out.authoringReady).toBe(true);
    expect(out.sandboxReady).toBe(false);
    expect(out.promotionReady).toBe(false);
    expect(out.next).toBeUndefined();
    expect(out.integrationGate?.identityGaps).toEqual([]);
    expect(out.integrationGate?.authoringOptionalGaps).toEqual([
      expect.objectContaining({
        requirement: expect.objectContaining({
          authoringOptional: expect.objectContaining({
            source: "action_step.condition",
            stepId: "optional_ownership_lock_check",
            evidence: expect.stringContaining("default off"),
          }),
        }),
      }),
    ]);
  });

  it("authors with exact RAAS and Allmeta tool identities while preserving an offline default-off API as generated-unverified work", async () => {
    const ontology = validOntology();
    ontology.actions[0]!.action_steps = [
      {
        order: 0,
        step_id: "persist_raas",
        name: "persistRaas",
        type: "tool",
        condition: "work normalized",
      },
      {
        order: 1,
        step_id: "mirror_allmeta",
        name: "mirrorAllmeta",
        type: "tool",
        condition: "RAAS write completed",
      },
      {
        order: 9,
        step_id: "optional_ownership_lock_check",
        name: "optionalOwnershipLockCheck",
        type: "logic",
        condition:
          "LOCK_CHECK_ENABLED=1 (default off); enforce only when LOCK_CHECK_ENFORCE=1",
        description:
          "Internal_Recruitment_System dark-launch lock lookup; preserve as a disabled boundary when unavailable.",
      },
    ] as never;
    ontology.actions[0]!.integration = {
      systems: [
        {
          call_order: 1,
          name: "RAAS_System",
          kind: "database",
          role: "write",
          capability: "candidate.save",
          objects: ["Work"],
        },
        {
          call_order: 2,
          name: "Allmeta_Ontology_System",
          kind: "graph_db",
          role: "write",
          capability: "instance.mirror",
          objects: ["Work"],
        },
        {
          call_order: 3,
          name: "Internal_Recruitment_System",
          kind: "external_api",
          role: "execute",
          capability: "read-lock-facts",
          objects: ["Work"],
        },
      ],
    };
    const ctx = context(ontology);
    ctx.ports.tools!.list = async () => [];
    ctx.ports.toolRegistry = {
      list: async () => [
        {
          name: "raas.records.upsert",
          operation: "write",
          effectScope: "external",
          sandboxPolicy: "requires_attempt_grant",
          capabilities: [
            {
              systems: ["RAAS_System"],
              kinds: ["database"],
              roles: ["write"],
              operations: ["candidate.save"],
              objectTypes: ["Work"],
              probeRequired: true,
            },
          ],
          probeStatus: "required",
          definitionHash: "sha256:raas-offline",
          verifiedDefinitionHashes: [],
        },
        {
          name: "ontology.writeInstance",
          operation: "write",
          effectScope: "external",
          sandboxPolicy: "requires_attempt_grant",
          capabilities: [
            {
              systems: ["Allmeta_Ontology_System"],
              kinds: ["graph_db"],
              roles: ["write"],
              operations: ["instance.mirror"],
              objectTypes: ["Work"],
              probeRequired: true,
            },
          ],
          probeStatus: "required",
          definitionHash: "sha256:allmeta-unprobed",
          verifiedDefinitionHashes: [],
        },
      ],
    };

    await readOntology.execute({}, ctx);
    const result = await inspectActionReadiness.execute(
      { action: "doWork" },
      ctx,
    );
    const out = result.output as {
      authoringReady?: boolean;
      sandboxReady?: boolean;
      promotionReady?: boolean;
      next?: string;
      integrationGate?: {
        effectiveTools?: string[];
        identityGaps?: unknown[];
        authoringOptionalGaps?: Array<{
          requirement: { system?: string };
        }>;
      };
    };

    expect(out.authoringReady).toBe(true);
    expect(out.sandboxReady).toBe(false);
    expect(out.promotionReady).toBe(false);
    expect(out.next).toBeUndefined();
    expect(out.integrationGate?.effectiveTools).toEqual([
      "raas.records.upsert",
      "ontology.writeInstance",
    ]);
    expect(out.integrationGate?.identityGaps).toEqual([]);
    expect(out.integrationGate?.authoringOptionalGaps).toEqual([
      expect.objectContaining({
        requirement: expect.objectContaining({
          system: "Internal_Recruitment_System",
        }),
      }),
    ]);
    expect(result.summary).toContain("已经可以生成草稿");
    expect(result.summary).toContain("沙箱");

    const designed = await designAgent.execute(
      {
        action: "doWork",
        system_prompt:
          "按 Ontology 契约写入 RAAS、镜像 Allmeta；默认关闭的锁检查保留为显式运行时边界。",
        decision_logic:
          "已绑定步骤按顺序执行；外部依赖不可用时报告未验证状态，不伪造成功回执。",
        tools: ["raas.records.upsert", "ontology.writeInstance"],
        plan: [
          {
            stepId: "persist_raas",
            kind: "tool",
            tool: "raas.records.upsert",
            idempotencyKeyFrom: "work_id",
            onError: "terminal",
          },
          {
            stepId: "mirror_allmeta",
            kind: "tool",
            tool: "ontology.writeInstance",
            idempotencyKeyFrom: "work_id",
            onError: "soft",
          },
          {
            stepId: "optional_ownership_lock_check",
            kind: "logic",
          },
        ],
      },
      ctx,
    );

    expect(designed).toMatchObject({
      ok: true,
      output: {
        tools: ["raas.records.upsert", "ontology.writeInstance"],
        readiness: {
          authoringReady: true,
          sandboxReady: false,
          promotionReady: false,
        },
      },
    });
    expect(ctx.specs).toHaveLength(1);
    expect(ctx.specs[0]?.generatedCode).toEqual(expect.any(String));
    expect(ctx.specs[0]?.generatedCode?.length).toBeGreaterThan(0);
    expect(ctx.specs[0]?.integrationBindings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          requirement: expect.objectContaining({
            system: "Internal_Recruitment_System",
            authoringOptional: expect.objectContaining({
              reason: "disabled_by_default",
            }),
          }),
          status: "missing",
        }),
      ]),
    );
  });

  it("does not treat vague optional prose as default-off execution evidence", async () => {
    const ontology = validOntology();
    ontology.actions[0]!.action_steps = [
      {
        order: 0,
        step_id: "optional_vendor_check",
        name: "optionalVendorCheck",
        type: "tool",
        condition: "可选情况下调用供应商",
      },
    ] as never;
    ontology.actions[0]!.integration = {
      systems: [
        {
          call_order: 1,
          name: "Optional Vendor",
          kind: "external_api",
          role: "execute",
          capability: "optional enrichment",
          objects: ["Work"],
        },
      ],
    };
    const ctx = context(ontology);
    ctx.ports.tools!.list = async () => [];

    await readOntology.execute({}, ctx);
    const result = await inspectActionReadiness.execute(
      { action: "doWork" },
      ctx,
    );
    const out = result.output as {
      authoringReady?: boolean;
      integrationGate?: {
        identityGaps?: unknown[];
        authoringOptionalGaps?: unknown[];
      };
    };

    expect(out.authoringReady).toBe(false);
    expect(out.integrationGate?.identityGaps).toHaveLength(1);
    expect(out.integrationGate?.authoringOptionalGaps).toEqual([]);
  });

  it("does not infer a default-off integration when zero/one-based step matching is ambiguous", async () => {
    const ontology = validOntology();
    ontology.actions[0]!.action_steps = [
      {
        order: 0,
        step_id: "candidate_zero_based",
        name: "candidateZeroBased",
        type: "tool",
        condition: "FEATURE_A=1 (默认关)",
      },
      {
        order: 1,
        step_id: "candidate_one_based",
        name: "candidateOneBased",
        type: "tool",
        condition: "FEATURE_B=1 (默认关)",
      },
    ] as never;
    ontology.actions[0]!.integration = {
      systems: [
        {
          call_order: 1,
          name: "Optional Vendor",
          kind: "external_api",
          role: "execute",
          capability: "optional enrichment",
          objects: ["Work"],
        },
      ],
    };
    const ctx = context(ontology);
    ctx.ports.tools!.list = async () => [];

    await readOntology.execute({}, ctx);
    const result = await inspectActionReadiness.execute(
      { action: "doWork" },
      ctx,
    );
    const out = result.output as {
      authoringReady?: boolean;
      integrationGate?: {
        identityGaps?: unknown[];
        authoringOptionalGaps?: unknown[];
      };
    };

    expect(out.authoringReady).toBe(false);
    expect(out.integrationGate?.identityGaps).toHaveLength(1);
    expect(out.integrationGate?.authoringOptionalGaps).toEqual([]);
  });

  it("does not use a disabled condition to break a zero/one-based positional tie", async () => {
    const ontology = validOntology();
    ontology.actions[0]!.action_steps = [
      {
        order: 0,
        step_id: "candidate_zero_based",
        name: "candidateZeroBased",
        type: "tool",
        condition: "FEATURE_A=1 (默认关)",
      },
      {
        order: 1,
        step_id: "candidate_one_based",
        name: "candidateOneBased",
        type: "tool",
        condition: "always",
      },
    ] as never;
    ontology.actions[0]!.integration = {
      systems: [
        {
          call_order: 1,
          name: "Optional Vendor",
          kind: "external_api",
          role: "execute",
          capability: "optional enrichment",
          objects: ["Work"],
        },
      ],
    };
    const ctx = context(ontology);
    ctx.ports.tools!.list = async () => [];

    await readOntology.execute({}, ctx);
    const result = await inspectActionReadiness.execute(
      { action: "doWork" },
      ctx,
    );
    const out = result.output as {
      authoringReady?: boolean;
      integrationGate?: {
        identityGaps?: unknown[];
        authoringOptionalGaps?: unknown[];
      };
    };

    expect(out.authoringReady).toBe(false);
    expect(out.integrationGate?.identityGaps).toHaveLength(1);
    expect(out.integrationGate?.authoringOptionalGaps).toEqual([]);
  });

  it("does not treat a rule-looking action name as structural rule evidence", async () => {
    const ontology = validOntology();
    const action = ontology.actions[0]!;
    action.id = "rule-check-work";
    action.name = "ruleCheckWork";
    action.action_steps = [];
    action.integration = { systems: [] };
    ontology.events[1]!.payload.source_action = "ruleCheckWork";
    const ctx = context(ontology);
    await readOntology.execute({}, ctx);
    const result = await designAgent.execute(
      {
        action: "ruleCheckWork",
        system_prompt: "根据运行时规则判断是否通过。",
        decision_logic: "通过 emit WORK_DONE；资料不足则终止。",
      },
      ctx,
    );
    expect(result.ok).toBe(true);
    expect(result.output).toMatchObject({
      tools: [],
      toolSelectionSource: "none",
    });
    expect(ctx.specs).toHaveLength(1);
    expect(ctx.specs[0]?.ruleRefs).toEqual([]);
  });

  it("grounds a structured rule action through exact action_steps references and custom capability metadata", async () => {
    const ontology = validOntology();
    const action = ontology.actions[0]!;
    const readerName = "policy.current.read";
    ontology.rules = [
      {
        id: "policy-1",
        name: "Current submission policy",
        description: "evaluate current submission",
      },
    ];
    action.action_steps = [
      {
        id: "fetch",
        name: "fetch",
        type: "tool",
        rules: [{ rule_id: "policy-1" }],
      },
    ];
    action.integration = {
      systems: [{ name: "Policy Store", kind: "rulebase", role: "reads" }],
    };
    action.tool_use = [readerName];
    const ctx = context(ontology);
    ctx.ports.tools!.list = async () => [];
    ctx.ports.toolRegistry = {
      list: async () => [
        {
          name: readerName,
          operation: "read",
          effectScope: "external",
          sandboxPolicy: "live_external",
          capabilities: [
            {
              systems: ["Policy Store"],
              kinds: ["rulebase"],
              roles: ["reads"],
            },
          ],
        },
      ],
    };

    await readOntology.execute({}, ctx);
    const contract = await readActionContract.execute(
      { action: "doWork" },
      ctx,
    );
    expect(contract.output).toMatchObject({
      readiness: { rulesReady: true },
      contract: {
        rules: {
          relevant: [{ id: "policy-1", name: "Current submission policy" }],
          unresolved: [],
          needsUserInput: false,
        },
      },
    });
    const readiness = await inspectActionReadiness.execute(
      { action: "doWork" },
      ctx,
    );
    expect(readiness.output).toMatchObject({
      unknownRules: [],
      integrationGate: { isRuleGate: true },
    });

    const result = await designAgent.execute(
      {
        action: "doWork",
        system_prompt: "运行时读取当前规则，并依据规则生成结构化结果。",
        decision_logic: "成功 emit WORK_DONE；读取失败则终止。",
        plan: [
          {
            stepId: "fetch",
            kind: "tool",
            tool: readerName,
            idempotencyKeyFrom: "work_id",
            onError: "terminal",
          },
        ],
      },
      ctx,
    );
    expect(result.ok).toBe(true);
    expect(ctx.specs[0]?.tools).toEqual([readerName]);
    expect(ctx.specs[0]?.ruleRefs).toEqual(["policy-1"]);
  });

  it("surfaces ambiguous action-step rule references and blocks design with ask_user", async () => {
    const ontology = validOntology();
    const action = ontology.actions[0]!;
    action.action_steps = [
      { id: "fetch", name: "fetch", type: "tool", rules: ["Duplicate policy"] },
    ];
    action.integration = { systems: [] };
    ontology.rules = [
      { id: "policy-a", name: "Duplicate policy" },
      { id: "policy-b", businessLogicRuleName: "Duplicate policy" },
    ];
    const ctx = context(ontology);

    const read = await readOntology.execute({}, ctx);
    const contract = await readActionContract.execute(
      { action: "doWork" },
      ctx,
    );
    expect(contract.output).toMatchObject({
      readiness: { rulesReady: false },
      contract: {
        rules: {
          relevant: [],
          needsUserInput: true,
          unresolved: [{ reason: "ambiguous" }],
        },
      },
    });
    const readiness = await inspectActionReadiness.execute(
      { action: "doWork" },
      ctx,
    );
    expect(readiness.output).toMatchObject({
      next: "ask_user",
      unknownRules: [{ reason: "ambiguous" }],
      integrationGate: { isRuleGate: true },
    });
    expect(read.summary).toContain("无法唯一解析");

    const result = await designAgent.execute(
      {
        action: "doWork",
        system_prompt: "读取明确规则后执行。",
        decision_logic: "成功 emit WORK_DONE；失败终止。",
      },
      ctx,
    );
    expect(result).toMatchObject({
      ok: false,
      output: {
        next: "ask_user",
        reason: "unresolved_ontology_rule_references",
      },
    });
    expect(ctx.specs).toHaveLength(0);
  });

  it("asks the user when explicitly selected tools have the same top integration score", async () => {
    const ontology = validOntology();
    const ctx = context(ontology);
    const capabilities = [
      {
        systems: ["Vendor"],
        kinds: ["external_api"],
        roles: ["reads"],
        operations: ["lookup"],
        objectTypes: ["Work"],
      },
    ];
    ctx.ports.tools!.list = async () => [];
    ctx.ports.toolRegistry = {
      list: async () => [
        {
          name: "vendor.alpha",
          operation: "read",
          effectScope: "external",
          sandboxPolicy: "live_external",
          capabilities,
        },
        {
          name: "vendor.beta",
          operation: "read",
          effectScope: "external",
          sandboxPolicy: "live_external",
          capabilities,
        },
      ],
    };
    await readOntology.execute({}, ctx);
    const result = await designAgent.execute(
      {
        action: "doWork",
        system_prompt: "按契约读取 Vendor 数据。",
        decision_logic: "成功 emit WORK_DONE；失败终止。",
        tools: ["vendor.alpha", "vendor.beta"],
        plan: [
          {
            stepId: "fetch",
            kind: "tool",
            tool: "vendor.alpha",
            idempotencyKeyFrom: "work_id",
            onError: "terminal",
          },
        ],
      },
      ctx,
    );
    expect(result).toMatchObject({
      ok: false,
      output: {
        next: "ask_user",
        reason: "ambiguous_integration_binding",
        candidates: [
          { kind: "tool", id: "vendor.alpha" },
          { kind: "tool", id: "vendor.beta" },
        ],
      },
    });
    expect(ctx.specs).toHaveLength(0);
  });

  it("blocks design and asks the user after a successfully fetched but referentially broken Ontology", async () => {
    const ontology = validOntology();
    ontology.actions[0]!.triggered_event = ["MISSING_EVENT"];
    const ctx = context(ontology);
    const read = await readOntology.execute({}, ctx);
    expect(read.ok).toBe(true);
    expect(ctx.ontologyReadiness?.ready).toBe(false);
    const result = await designAgent.execute(
      { action: "doWork", system_prompt: "x", decision_logic: "x" },
      ctx,
    );
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({
      output: {
        next: "ask_user",
        reason: "authoritative_ontology_contract_unresolved",
        missing: expect.arrayContaining(["authoritative_ontology_corrections"]),
      },
    });
    expect(result.summary).toContain("AllmetaOntology");
    expect(ctx.specs).toHaveLength(0);
  });

  it("revise_ontology produces an authoritative correction proposal without reopening the working-copy gate", async () => {
    const ontology = validOntology();
    // Use a field that cannot be proven from the Event by name. A same-name
    // Event field is intentionally normalized without asking the user.
    ontology.actions[0]!.inputs = [
      { name: "request_key", type: "String", required: true },
    ];
    const ctx = context(ontology);
    await readOntology.execute({}, ctx);
    expect(ctx.ontologyReadiness?.ready).toBe(false);
    expect(ctx.ontologyReadiness!.blocking.map((i) => i.code)).toContain(
      "action_input_binding_kind_missing",
    );
    const before = ctx.ontologyReadiness!.blocking.length;
    const beforeOntology = JSON.stringify(ctx.ontology);
    const beforeReadiness = ctx.ontologyReadiness;
    const emitted: unknown[] = [];
    ctx.emit = (event) => {
      emitted.push(event);
    };

    const revised = await reviseOntology.execute(
      {
        inputs: [
          {
            action: "doWork",
            field: "request_key",
            set: { binding_kind: "event", event_field: "work_id" },
          },
        ],
      },
      ctx,
    );

    expect(revised.ok).toBe(false);
    expect(revised).toMatchObject({
      output: {
        next: "ask_user",
        reason: "authoritative_ontology_update_required",
        committed: false,
        proposalReady: true,
        applied: [],
      },
    });
    expect(revised.summary).toContain("Allmeta");
    expect((revised.output as { blockingAfter: number }).blockingAfter).toBe(
      before,
    );
    expect(
      (revised.output as { proposedBlockingAfter: number })
        .proposedBlockingAfter,
    ).toBeLessThan(before);
    expect(
      (revised.output as { candidateChanges: unknown[] }).candidateChanges
        .length,
    ).toBeGreaterThan(0);
    expect(
      (revised.output as { newBlocking: unknown[] }).newBlocking,
    ).toHaveLength(0);
    expect(
      (revised.output as { removedBlocking: Array<{ key: string }> })
        .removedBlocking[0]?.key,
    ).toContain("ontology-readiness/v1");
    expect(JSON.stringify(ctx.ontology)).toBe(beforeOntology);
    expect(ctx.ontologyReadiness).toBe(beforeReadiness);
    expect(ctx.ontologyReadiness!.blocking.map((i) => i.code)).toContain(
      "action_input_binding_kind_missing",
    );
    expect(
      emitted.some((event) => (event as { t?: string }).t === "ontology.heal"),
    ).toBe(false);
    // a patch that references a non-existent action is rejected, never invented
    const rejectedRun = await reviseOntology.execute(
      {
        inputs: [
          { action: "ghostAction", field: "x", set: { binding_kind: "event" } },
        ],
      },
      ctx,
    );
    expect(rejectedRun.ok).toBe(false);
    expect(
      (rejectedRun.output as { rejected: unknown[] }).rejected,
    ).toHaveLength(1);
  });

  it("treats an equal primary-key patch as a keyed no-op, not an applied repair", async () => {
    const ctx = context(validOntology());
    await readOntology.execute({}, ctx);
    const beforeOntology = JSON.stringify(ctx.ontology);
    const beforeReadiness = ctx.ontologyReadiness;

    const result = await reviseOntology.execute(
      {
        objects: [{ object: "Work", primary_key: "work_id" }],
      },
      ctx,
    );

    expect(result.ok).toBe(false);
    expect(result.output).toMatchObject({
      committed: false,
      applied: [],
      candidateChanges: [],
    });
    const noops = (
      result.output as { noops: Array<{ key: string; target: string }> }
    ).noops;
    expect(noops).toHaveLength(1);
    expect(noops[0]?.key).toContain("ontology-revision/v1");
    expect(noops[0]?.target).toBe("object Work.primary_key");
    expect(JSON.stringify(ctx.ontology)).toBe(beforeOntology);
    expect(ctx.ontologyReadiness).toBe(beforeReadiness);
  });

  it("rolls back a bad event binding that would add a new blocker", async () => {
    const ontology = validOntology();
    ontology.actions[0]!.inputs!.push({
      name: "result",
      type: "String",
      required: true,
      binding_kind: "object_lookup",
      source_object: "Work.result",
      lookup_args: { work_id: "input.work_id" },
      result_path: "result",
      integration_ref: "Vendor",
    });
    const ctx = context(ontology);
    const emitted: unknown[] = [];
    ctx.emit = (event) => {
      emitted.push(event);
    };
    await readOntology.execute({}, ctx);
    expect(ctx.ontologyReadiness?.ready).toBe(true);
    emitted.length = 0;
    const beforeOntology = JSON.stringify(ctx.ontology);
    const beforeReadiness = ctx.ontologyReadiness;

    const result = await reviseOntology.execute(
      {
        inputs: [
          { action: "doWork", field: "result", set: { binding_kind: "event" } },
        ],
      },
      ctx,
    );

    expect(result.ok).toBe(false);
    expect(result.output).toMatchObject({ committed: false, applied: [] });
    expect(
      (result.output as { newBlocking: Array<{ code: string; key: string }> })
        .newBlocking,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "action_required_input_unbound" }),
      ]),
    );
    expect(
      (result.output as { newBlocking: Array<{ key: string }> }).newBlocking[0]
        ?.key,
    ).toContain("ontology-readiness/v1");
    expect(JSON.stringify(ctx.ontology)).toBe(beforeOntology);
    expect(ctx.ontologyReadiness).toBe(beforeReadiness);
    expect(
      emitted.some((event) => (event as { t?: string }).t === "ontology.heal"),
    ).toBe(false);
  });

  it("checks every trigger event and rolls back when one trigger cannot supply the required input", async () => {
    const ontology = validOntology();
    ontology.events.push({
      name: "WORK_REQUESTED_ALTERNATE",
      payload: {
        source_action: null,
        event_data: [
          { name: "tenant_id", type: "String", target_object: "Work" },
        ],
        state_mutations: [],
      },
    });
    ontology.actions[0]!.trigger.push("WORK_REQUESTED_ALTERNATE");
    ontology.actions[0]!.inputs = [
      { name: "work_id", type: "String", required: true },
    ];
    const ctx = context(ontology);
    await readOntology.execute({}, ctx);
    const beforeOntology = JSON.stringify(ctx.ontology);
    const result = await reviseOntology.execute(
      {
        inputs: [
          {
            action: "doWork",
            field: "work_id",
            set: { binding_kind: "event", event_field: "work_id" },
          },
        ],
      },
      ctx,
    );

    expect(result.ok).toBe(false);
    expect(
      (result.output as { removedBlocking: unknown[] }).removedBlocking.length,
    ).toBeGreaterThan(0);
    expect(
      (
        result.output as {
          newBlocking: Array<{ code: string; event?: string }>;
        }
      ).newBlocking,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "action_required_input_unbound",
          event: "WORK_REQUESTED_ALTERNATE",
        }),
      ]),
    );
    expect(JSON.stringify(ctx.ontology)).toBe(beforeOntology);
  });

  it("atomically rolls back mixed repairs when one good change removes blockers but another creates one", async () => {
    const ontology = validOntology();
    ontology.actions[0]!.inputs = [
      { name: "request_key", type: "String", required: true },
      {
        name: "result",
        type: "String",
        required: true,
        binding_kind: "object_lookup",
        source_object: "Work.result",
        lookup_args: { work_id: "input.request_key" },
        result_path: "result",
        integration_ref: "Vendor",
      },
    ];
    const ctx = context(ontology);
    const emitted: unknown[] = [];
    ctx.emit = (event) => {
      emitted.push(event);
    };
    await readOntology.execute({}, ctx);
    emitted.length = 0;
    const beforeOntology = JSON.stringify(ctx.ontology);
    const beforeReadiness = ctx.ontologyReadiness;

    const result = await reviseOntology.execute(
      {
        inputs: [
          {
            action: "doWork",
            field: "request_key",
            set: { binding_kind: "event", event_field: "work_id" },
          },
          { action: "doWork", field: "result", set: { binding_kind: "event" } },
        ],
      },
      ctx,
    );

    expect(result.ok).toBe(false);
    expect(
      (result.output as { candidateChanges: unknown[] }).candidateChanges
        .length,
    ).toBeGreaterThan(0);
    expect(
      (result.output as { removedBlocking: unknown[] }).removedBlocking.length,
    ).toBeGreaterThan(0);
    expect(
      (result.output as { newBlocking: unknown[] }).newBlocking.length,
    ).toBeGreaterThan(0);
    expect((result.output as { applied: unknown[] }).applied).toHaveLength(0);
    expect(JSON.stringify(ctx.ontology)).toBe(beforeOntology);
    expect(ctx.ontologyReadiness).toBe(beforeReadiness);
    expect(
      emitted.some((event) => (event as { t?: string }).t === "ontology.heal"),
    ).toBe(false);
  });

  it("rejects Event producer/consumer edits and rolls back otherwise valid mixed repairs", async () => {
    const ontology = validOntology();
    ontology.actions[0]!.inputs = [
      { name: "work_id", type: "String", required: true },
    ];
    const ctx = context(ontology);
    const emitted: unknown[] = [];
    ctx.emit = (event) => {
      emitted.push(event);
    };
    await readOntology.execute({}, ctx);
    emitted.length = 0;
    const beforeOntology = JSON.stringify(ctx.ontology);
    const beforeReadiness = ctx.ontologyReadiness;

    // Direct execute deliberately bypasses JSON-schema validation. The server
    // still must not let a model smuggle a business-route edit into the patch.
    const result = await reviseOntology.execute(
      {
        inputs: [
          {
            action: "doWork",
            field: "work_id",
            set: { binding_kind: "event", event_field: "work_id" },
          },
        ],
        events: [{ event: "WORK_REQUESTED", add_consumers: ["doWork"] }],
      },
      ctx,
    );

    expect(result.ok).toBe(false);
    expect(result.output).toMatchObject({ committed: false, applied: [] });
    expect(
      (result.output as { candidateChanges: unknown[] }).candidateChanges
        .length,
    ).toBeGreaterThan(0);
    expect(
      (result.output as { rejected: Array<{ reason: string }> }).rejected[0]
        ?.reason,
    ).toContain("ask_user");
    expect(
      (result.output as { rejected: Array<{ reason: string }> }).rejected[0]
        ?.reason,
    ).toContain("AllmetaOntology API");
    expect(JSON.stringify(ctx.ontology)).toBe(beforeOntology);
    expect(ctx.ontologyReadiness).toBe(beforeReadiness);
    expect(
      emitted.some((event) => (event as { t?: string }).t === "ontology.heal"),
    ).toBe(false);

    const reviseSchema = reviseOntology.parameters as {
      properties: {
        events: { items: { properties: Record<string, unknown> } };
      };
    };
    expect(reviseSchema.properties.events.items.properties).not.toHaveProperty(
      "add_producers",
    );
    expect(reviseSchema.properties.events.items.properties).not.toHaveProperty(
      "add_consumers",
    );
  });

  it("exposes foreach/emit to the model and rejects literal secrets in tool definitions", async () => {
    const schema = designAgent.parameters as {
      properties: { plan: { items: { properties: Record<string, unknown> } } };
    };
    const kinds = (
      schema.properties.plan.items.properties.kind as { enum: string[] }
    ).enum;
    expect(kinds).toEqual(
      expect.arrayContaining(["foreach", "invoke", "emit"]),
    );
    expect(schema.properties.plan.items.properties).toHaveProperty("body");
    expect(schema.properties.plan.items.properties).toHaveProperty("emitEvent");
    expect(schema.properties.plan.items.properties).toHaveProperty(
      "errorPolicy",
    );
    expect(
      (
        schema.properties.plan.items.properties.body as {
          items: { $ref: string };
        }
      ).items.$ref,
    ).toBe("#/$defs/planStep");
    const errorPolicy = schema.properties.plan.items.properties.errorPolicy as {
      items: {
        properties: { do: { enum: string[] }; suppressEmit: { type: string } };
      };
    };
    expect(errorPolicy.items.properties.do.enum).toEqual(
      expect.arrayContaining(["retry", "terminal", "continue"]),
    );
    expect(errorPolicy.items.properties.suppressEmit.type).toBe("boolean");

    const ctx = context(validOntology());
    const unsafe = await createTool.execute(
      {
        name: "vendor.secret",
        description: "bad",
        method: "GET",
        url_template: "https://api.example.com",
        side_effect: "read",
        headers: { authorization: "Bearer literal-secret" },
      },
      ctx,
    );
    expect(unsafe.ok).toBe(false);
    expect(unsafe.summary).toContain("字面值");
  });
});
