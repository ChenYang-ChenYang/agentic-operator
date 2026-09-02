/**
 * Golden compile of the real power-scm source (vendored verbatim from
 * allmetaOntology demo-packages/power-scm/dist into test/fixtures) against the
 * REAL runtime manifest contract.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { WorkflowManifestSchema } from "@agentic/runtime/manifest";
import { canonicalJson } from "../src/canonical-json.ts";
import { compile, serializeCompileResult } from "../src/compile.ts";
import { loadStudioDomain } from "../src/load.ts";
import type {
  CompiledAgent,
  CompiledStep,
  CompilerOverlay,
  StudioEventDataField,
} from "../src/types.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_SOURCE = path.join(here, "fixtures", "power-scm");
const OVERLAY_PATH = path.join(here, "..", "..", "..", "overlays", "power-scm.json");

function loadOverlayFixture(): CompilerOverlay {
  return JSON.parse(readFileSync(OVERLAY_PATH, "utf8")) as CompilerOverlay;
}

function compilePowerScm() {
  const model = loadStudioDomain(FIXTURE_SOURCE);
  return compile(model, loadOverlayFixture(), { tenant: "power-scm" });
}

function agentById(workflow: CompiledAgent[], id: string): CompiledAgent {
  const agent = workflow.find((candidate) => candidate.id === id);
  if (!agent) throw new Error(`missing agent ${id}`);
  return agent;
}

function stepNames(agent: CompiledAgent): string[] {
  return agent.actions.map((step) => step.name);
}

describe("ontology-compiler golden compile (power-scm)", () => {
  const result = compilePowerScm();

  it("emits one AgentSpec per ontology action (19 agents)", () => {
    expect(result.workflow).toHaveLength(19);
    const ids = result.workflow.map((agent) => agent.id);
    expect(new Set(ids).size).toBe(19);
    for (const agent of result.workflow) {
      expect(agent.name).toBe(agent.id);
      expect(agent.retries).toBe(3);
      expect(agent.generated).toBe(true);
    }
  });

  it("every emitted AgentSpec parses through the real WorkflowManifestSchema", () => {
    // Round-trip through JSON like the on-disk manifest loader would see it.
    const raw = JSON.parse(canonicalJson(result.workflow));
    const parsed = WorkflowManifestSchema.parse(raw);
    expect(parsed).toHaveLength(19);
  });

  it("wires triggers: typhoon forecast and stock transfer", () => {
    expect(agentById(result.workflow, "action-forecast-typhoon-impact").trigger).toEqual([
      "PSCM_TYPHOON_ALERT_RECEIVED",
    ]);
    expect(agentById(result.workflow, "action-create-stock-transfer").trigger).toEqual([
      "PSCM_STOCK_GAP_IDENTIFIED",
    ]);
  });

  it("synthesizes MANUAL_<ID> triggers when MANUAL was the only trigger", () => {
    expect(agentById(result.workflow, "action-release-inventory").trigger).toEqual([
      "MANUAL_ACTION_RELEASE_INVENTORY",
    ]);
    expect(agentById(result.workflow, "action-review-emergency-response").trigger).toEqual([
      "MANUAL_ACTION_REVIEW_EMERGENCY_RESPONSE",
    ]);
    // MANUAL alongside real events is simply dropped.
    expect(agentById(result.workflow, "action-lock-inventory").trigger).toEqual([
      "PSCM_STOCK_GAP_IDENTIFIED",
    ]);
  });

  it("compiles rule gates on create-emergency-po (EMG-002 + EMG-004) and send-rfq (RSK-002)", () => {
    const po = agentById(result.workflow, "action-create-emergency-po");
    const poSteps = stepNames(po);
    expect(poSteps).toContain("rule-gate:PSCM-EMG-002");
    expect(poSteps).toContain("rule-gate:PSCM-EMG-004");
    // EMG-002 is jsonlogic → deterministic condition gate.
    const emg002 = po.actions.find((step) => step.name === "rule-gate:PSCM-EMG-002")!;
    expect(emg002.type).toBe("condition");
    expect(emg002.condition).toBe(
      "input.gap_report.available_qty < input.gap_report.forecast_qty",
    );
    // EMG-004 is natural language → strict-JSON logic judge + verdict gate.
    const emg004 = po.actions.find((step) => step.name === "rule-gate:PSCM-EMG-004")!;
    expect(emg004.type).toBe("logic");
    expect(emg004.on_error).toBe("terminal");
    expect(emg004.action_prompt).toContain('"status":"violation"');
    const verdict = po.actions.find((step) => step.name === "rule-verdict:PSCM-EMG-004")!;
    expect(verdict.type).toBe("condition");
    expect(verdict.condition).toBe("results.rule-gate-PSCM-EMG-004.status == 'pass' || results.rule-gate-PSCM-EMG-004.status == 'PASS'");

    const rfq = agentById(result.workflow, "action-send-rfq");
    const rfqGate = rfq.actions.find((step) => step.name === "rule-gate:PSCM-RSK-002")!;
    expect(rfqGate.type).toBe("logic");
    expect(rfqGate.on_error).toBe("terminal");
    expect(stepNames(rfq)).toContain("rule-verdict:PSCM-RSK-002");
  });

  it("gates the ERP write and success emission behind rule gates + manual approval", () => {
    const po = agentById(result.workflow, "action-create-emergency-po");
    const tool = po.actions.find((step) => step.type === "tool")!;
    expect(tool.name).toBe("metaerp.invoke");
    expect(tool.result_key).toBe("action-create-emergency-po");
    expect(tool.allowed_tools).toEqual(["metaerp.invoke"]);
    expect(tool.depends_on).toEqual([
      "rule-gate-PSCM-EMG-002",
      "rule-verdict-PSCM-EMG-004",
      "manual-3",
    ]);
    const emit = po.actions.find((step) => step.type === "emit")!;
    expect(emit.emit_event).toBe("PSCM_EMERGENCY_PO_CREATED");
    expect(emit.depends_on).toEqual(["action-create-emergency-po"]);
    // Skipped gates must not fall back to the implicit triggered_event[0].
    expect(stepNames(po)).toContain("suppress-implicit-emit");
  });

  it("compiles manual approval steps on transfer / po / confirm-allocation", () => {
    const transfer = agentById(result.workflow, "action-create-stock-transfer");
    const transferManuals = transfer.actions.filter((step) => step.type === "manual");
    expect(transferManuals.map((step) => step.name)).toEqual(["应急审批"]);
    expect(transferManuals[0]!.awaiting_role).toBe("物资部主任");
    expect(transferManuals[0]!.form_schema).toBeDefined();

    const po = agentById(result.workflow, "action-create-emergency-po");
    expect(po.actions.filter((step) => step.type === "manual").map((step) => step.name)).toEqual([
      "应急审批",
    ]);

    const confirm = agentById(result.workflow, "action-confirm-allocation");
    const confirmManuals = confirm.actions.filter((step) => step.type === "manual");
    expect(confirmManuals.map((step) => step.name)).toEqual(["调出方确认", "调入方确认"]);
    expect(confirmManuals.map((step) => step.awaiting_role)).toEqual([
      "调出方物资员",
      "调入方物资员",
    ]);
  });

  it("compiles prompt actions to a single logic step with pinned query tools", () => {
    const forecast = agentById(result.workflow, "action-forecast-typhoon-impact");
    const logicSteps = forecast.actions.filter((step) => step.type === "logic");
    expect(logicSteps).toHaveLength(1);
    const logic = logicSteps[0]!;
    expect(logic.result_key).toBe("action-forecast-typhoon-impact");
    expect(logic.action_prompt).toContain("输出契约");
    expect(logic.action_prompt).toContain("gap_report");
    expect(logic.allowed_tools).toEqual(["metaerp.invoke"]);
    // Multi-operation query agents carry exactly ONE merged metaerp.invoke
    // entry (runtime lifts config by name — first match wins; providers reject
    // duplicate tool names), with the operation choice constrained by an
    // input_schema enum instead of a config pin.
    expect(forecast.tool_use).toHaveLength(1);
    const merged = forecast.tool_use[0]!;
    expect(merged.name).toBe("metaerp.invoke");
    expect(merged.config.operation).toBeUndefined();
    expect(merged.config.base_url_env).toBe("METAERP_BASE_URL");
    expect(merged.config.catalog_path).toBe("models/power-scm-v1/erp-operations.json");
    const opSchema = (merged.input_schema as { properties: { operation: { enum: string[] } } })
      .properties.operation;
    expect(opSchema.enum).toEqual(["queryGridAssets", "queryInventoryLots", "queryRepairHistory"]);
    // "always" overlay emission → unconditional explicit emit step.
    const emit = forecast.actions.find((step) => step.type === "emit")!;
    expect(emit.emit_event).toBe("PSCM_STOCK_GAP_IDENTIFIED");
    expect(emit.emit_payload_from).toBe("results.action-forecast-typhoon-impact");
    expect(emit.depends_on).toBeUndefined();

    // Agent-level ontology cards: target objects + bound rules.
    expect(forecast.ontology_instructions).toContain("【目标对象】");
    expect(forecast.ontology_instructions).toContain("PSCM-EMG-001");
  });

  it("compiles overlay conditional emissions for the dormant-stock matcher", () => {
    const match = agentById(result.workflow, "action-match-dormant-stock");
    const names = stepNames(match);
    expect(names).toContain("emit-when:PSCM_DORMANT_MATCH_FOUND");
    expect(names).toContain("emit:PSCM_DORMANT_MATCH_FOUND");
    expect(names).toContain("emit-when:PSCM_IMPAIRMENT_WARNING_RAISED");
    expect(names).toContain("emit:PSCM_IMPAIRMENT_WARNING_RAISED");
    expect(names).toContain("suppress-implicit-emit");
    const matchWhen = match.actions.find(
      (step) => step.name === "emit-when:PSCM_DORMANT_MATCH_FOUND",
    )!;
    expect(matchWhen.condition).toBe("lastResult.match_found == true");
    const matchEmit = match.actions.find(
      (step) => step.name === "emit:PSCM_DORMANT_MATCH_FOUND",
    )!;
    expect(matchEmit.depends_on).toEqual(["emit-when-PSCM_DORMANT_MATCH_FOUND"]);
    expect(matchEmit.emit_payload_from).toBe("results.action-match-dormant-stock");
  });

  it("maps ERP write tool arguments from the overlay (transfer lines from the gap event)", () => {
    const transfer = agentById(result.workflow, "action-create-stock-transfer");
    const tool = transfer.actions.find((step) => step.type === "tool")!;
    expect(tool.tool_arguments).toEqual({
      payload: { from: "event.data.gap_report.transfer" },
    });
    const [entry] = transfer.tool_use;
    expect(entry!.config.operation).toBe("createTransferOrder");
    expect(entry!.execution_policy).toEqual({
      operation: "read_write",
      effect_scope: "external",
      sandbox_policy: "requires_attempt_grant",
    });
  });

  it("emits the erp-operations catalog from transform maps (24 queries + 15 writes)", () => {
    const queries = result.erpOperations.filter((operation) => operation.kind === "query");
    const writes = result.erpOperations.filter((operation) => operation.kind === "write");
    expect(queries).toHaveLength(24);
    expect(writes).toHaveLength(15);
    const transferWrite = writes.find((operation) => operation.operation_id === "createTransferOrder")!;
    expect(transferWrite).toEqual({
      operation_id: "createTransferOrder",
      method: "POST",
      path: "/metaerp/openapi/v1/createTransferOrder",
      kind: "write",
      entity: "wm_transfer_order_t",
    });
    const lotQuery = queries.find((operation) => operation.operation_id === "queryInventoryLots")!;
    expect(lotQuery.entity).toBe("wm_inventory_lot_t");
    // Sorted by operation_id for byte-stable output.
    const ids = result.erpOperations.map((operation) => operation.operation_id);
    expect(ids).toEqual([...ids].sort((a, b) => a.localeCompare(b, "en")));
  });

  it("passes events/objects/rules/actions through as AO catalog projections", () => {
    expect(Array.isArray(result.actions)).toBe(true);
    expect((result.actions as unknown[]).length).toBe(19);
    expect(result.events.events).toHaveLength(25);
    expect(result.objects.payload).toHaveLength(27);
    expect(result.rules.payload).toHaveLength(11);
  });

  it("is deterministic: two independent compiles serialize byte-identically", () => {
    const again = compilePowerScm();
    const first = serializeCompileResult(result);
    const second = serializeCompileResult(again);
    expect([...second.keys()]).toEqual([...first.keys()]);
    for (const [fileName, value] of first) {
      expect(canonicalJson(second.get(fileName)), fileName).toBe(canonicalJson(value));
    }
  });
});

describe("overlay extra_tools (ontology.query grants)", () => {
  const ONTOLOGY_QUERY_POLICY = {
    operation: "read",
    effect_scope: "external",
    sandbox_policy: "live_external",
  };

  function overlayWithGrants(): CompilerOverlay {
    return {
      ...loadOverlayFixture(),
      extra_tools: {
        "action-scan-supplier-risk": [
          {
            name: "ontology.query",
            description: "查询本体图谱中的供应商实控人（实控人/股权关联证据不在 ERP 中）。",
            config: {
              tenant_property: "tenant_slug",
              id_property: "instanceId",
              database: "neo4j",
            },
          },
        ],
        "action-send-rfq": [
          {
            name: "ontology.query",
            description: "裁决前可从本体图谱核验供应商实控人与股权关联。",
            config: { tenant_property: "tenant_slug", id_property: "instanceId" },
            grant_to_judges: true,
          },
        ],
      },
    };
  }

  function compileWithGrants() {
    const model = loadStudioDomain(FIXTURE_SOURCE);
    return compile(model, overlayWithGrants(), { tenant: "power-scm" });
  }

  it("grants the analyze step an ontology.query entry with the exact reviewed read-only policy", () => {
    const result = compileWithGrants();
    const scan = agentById(result.workflow, "action-scan-supplier-risk");
    // Appended AFTER the existing merged metaerp.invoke query entry; one
    // entry per tool name (runtime lifts config by name, first match wins).
    expect(scan.tool_use.map((entry) => entry.name)).toEqual([
      "metaerp.invoke",
      "ontology.query",
    ]);
    const entry = scan.tool_use[1]!;
    expect(entry.side_effect).toBe("read");
    expect(entry.execution_policy).toEqual(ONTOLOGY_QUERY_POLICY);
    // Overlay description + config pass through verbatim.
    expect(entry.description).toContain("实控人");
    expect(entry.config).toEqual({
      tenant_property: "tenant_slug",
      id_property: "instanceId",
      database: "neo4j",
    });
    const opSchema = (entry.input_schema as { properties: { operation: { enum: string[] } } })
      .properties.operation;
    expect(opSchema.enum).toEqual([
      "search_nodes",
      "get_node",
      "neighbors",
      "find_paths",
      "schema",
    ]);
    const analyze = scan.actions.find((step) => step.name === "analyze")!;
    expect(analyze.allowed_tools).toEqual(["metaerp.invoke", "ontology.query"]);
  });

  it("grant_to_judges extends the rule-gate judge roster and prompt on send-rfq", () => {
    const result = compileWithGrants();
    const rfq = agentById(result.workflow, "action-send-rfq");
    expect(rfq.tool_use.map((entry) => entry.name)).toEqual([
      "metaerp.invoke",
      "ontology.query",
    ]);
    expect(rfq.tool_use[1]!.execution_policy).toEqual(ONTOLOGY_QUERY_POLICY);
    const judge = rfq.actions.find((step) => step.name === "rule-gate:PSCM-RSK-002")!;
    expect(judge.allowed_tools).toEqual(["ontology.query"]);
    expect(judge.action_prompt).toContain("ontology.query");
    expect(judge.action_prompt).toContain("必须先查询图谱再裁决");
    expect(judge.action_prompt).toContain("维持 fail-closed，判 violation");
    // The deterministic tool write step is untouched.
    const tool = rfq.actions.find((step) => step.type === "tool")!;
    expect(tool.allowed_tools).toEqual(["metaerp.invoke"]);
    // Without any grant the RSK-002 judge never mentions the graph tool. The
    // baseline must be an explicitly grant-free overlay: the shipped
    // overlays/power-scm.json is operator-editable and does carry grants, so
    // reading it here would silently turn this negative assertion into a
    // tautology (or a false failure) the moment production config changes.
    const { extra_tools: _granted, ...withoutGrants } = overlayWithGrants();
    const baseline = compile(loadStudioDomain(FIXTURE_SOURCE), withoutGrants, {
      tenant: "power-scm",
    });
    const baseJudge = agentById(baseline.workflow, "action-send-rfq").actions.find(
      (step) => step.name === "rule-gate:PSCM-RSK-002",
    )!;
    expect(baseJudge.allowed_tools).toEqual([]);
    expect(baseJudge.action_prompt).not.toContain("ontology.query");
  });

  it("granted manifests still parse through the real WorkflowManifestSchema and stay deterministic", () => {
    const result = compileWithGrants();
    const raw = JSON.parse(canonicalJson(result.workflow));
    expect(WorkflowManifestSchema.parse(raw)).toHaveLength(19);
    const again = compileWithGrants();
    expect(canonicalJson(again.workflow)).toBe(canonicalJson(result.workflow));
  });

  it("rejects an extra tool name without a compiler-known reviewed policy", () => {
    const model = loadStudioDomain(FIXTURE_SOURCE);
    const overlay: CompilerOverlay = {
      ...loadOverlayFixture(),
      extra_tools: { "action-send-rfq": [{ name: "fs.readFromInbox" }] },
    };
    expect(() => compile(model, overlay, { tenant: "power-scm" })).toThrow(
      /unsupported tool "fs\.readFromInbox"/,
    );
  });

  it("rejects extra_tools grants on unknown actions", () => {
    const model = loadStudioDomain(FIXTURE_SOURCE);
    const overlay: CompilerOverlay = {
      ...loadOverlayFixture(),
      extra_tools: { "action-does-not-exist": [{ name: "ontology.query" }] },
    };
    expect(() => compile(model, overlay, { tenant: "power-scm" })).toThrow(
      /extra_tools references unknown action/,
    );
  });

  // ontology.query reads its Neo4j credentials from whatever env names
  // `username_env`/`password_env` point at, so an overlay able to set them
  // would choose which server secret is sent as a Basic-auth password.
  it.each(["username_env", "password_env", "base_url"])(
    "refuses an overlay config that sets the operator-owned key %s",
    (key) => {
      const model = loadStudioDomain(FIXTURE_SOURCE);
      const overlay: CompilerOverlay = {
        ...loadOverlayFixture(),
        extra_tools: {
          "action-send-rfq": [
            { name: "ontology.query", config: { [key]: "OPENROUTER_API_KEY" } },
          ],
        },
      };
      expect(() => compile(model, overlay, { tenant: "power-scm" })).toThrow(
        new RegExp(`may not set operator-owned key\\(s\\) ${key}`),
      );
    },
  );

  it("marks computed properties as derived so an agent does not query for them", () => {
    // PSCM-INV-001 gates on age_days, which no ERP column supplies; the ERP
    // exposes inbound_date and the ontology derives the rest.
    const match = agentById(compilePowerScm().workflow, "action-match-dormant-stock");
    const instructions = match.ontology_instructions ?? "";
    expect(instructions).toContain("age_days（推导＝today() - inbound_date）");
    // ERP-sourced siblings stay bare.
    expect(instructions).toContain("inbound_date");
    expect(instructions).not.toContain("inbound_date（推导");
  });

  it("advertises the neighbors filters the tool actually reads", () => {
    const scan = agentById(compileWithGrants().workflow, "action-scan-supplier-risk");
    const schema = scan.tool_use[1]!.input_schema as {
      additionalProperties: boolean;
      properties: Record<string, unknown>;
    };
    // The schema is closed, so anything it omits is unreachable for the model.
    expect(schema.additionalProperties).toBe(false);
    expect(Object.keys(schema.properties)).toEqual(
      expect.arrayContaining(["relationship_types", "neighbor_labels"]),
    );
  });
});

describe("dependency gating consistency", () => {
  const result = compilePowerScm();

  it("every depends_on entry references a prior sibling key", () => {
    for (const agent of result.workflow) {
      const prior = new Set<string>();
      for (const step of agent.actions as CompiledStep[]) {
        for (const dependency of step.depends_on ?? []) {
          expect(prior.has(dependency), `${agent.id}:${step.name} → ${dependency}`).toBe(true);
        }
        prior.add(step.result_key ?? step.name);
      }
    }
  });

  it("every emit step's event is declared in the agent's triggered_event", () => {
    for (const agent of result.workflow) {
      for (const step of agent.actions) {
        if (step.type !== "emit") continue;
        expect(agent.triggered_event, `${agent.id}:${step.name}`).toContain(step.emit_event);
      }
    }
  });

  it("agents with skippable emits carry the implicit-emit suppression floor", () => {
    for (const agent of result.workflow) {
      const hasSkippableEmit = agent.actions.some(
        (step) => step.type === "emit" && (step.depends_on?.length ?? 0) > 0,
      );
      if (!hasSkippableEmit) continue;
      expect(stepNames(agent), agent.id).toContain("suppress-implicit-emit");
    }
  });
});

describe("compiled input ports", () => {
  const model = loadStudioDomain(FIXTURE_SOURCE);
  const agents = compilePowerScm().workflow;

  const eventFields = (agent: CompiledAgent) =>
    agent.trigger.flatMap(
      (event) =>
        model.events.find((candidate) => candidate.name === event)?.payload
          ?.event_data ?? [],
    );

  // Without `inputs` the run console falls back to a generic payload/prompt
  // pair, and the default event body carries none of the fields the agent's own
  // prompt requires. The ports come from the trigger event's own schema.
  it("gives every triggered agent the fields its trigger declares", () => {
    for (const agent of agents) {
      const declared = new Set(eventFields(agent).map((field) => field.name));
      const actual = new Set(agent.inputs.map((port) => port.id));
      for (const name of declared) expect(actual.has(name)).toBe(true);
    }
  });

  it("carries `required` through, so the console can mark it", () => {
    for (const agent of agents) {
      for (const port of agent.inputs) {
        const field = eventFields(agent).find(
          (candidate) => candidate.name === port.id,
        );
        expect(port.required).toBe(field?.required === true);
      }
    }
  });

  /** Compile one probe field and hand back the port it produced. */
  function probePort(field: StudioEventDataField) {
    const probed = {
      ...model,
      events: [
        { name: "__PROBE__", payload: { event_data: [field] } },
        ...model.events,
      ],
      actions: model.actions.map((action, index) =>
        index === 0 ? { ...action, trigger: ["__PROBE__"] } : action,
      ),
    };
    const [port] = compile(probed, loadOverlayFixture(), {
      tenant: "power-scm",
    }).workflow[0]!.inputs;
    return (port?.schema ?? {}) as Record<string, unknown>;
  }

  // A bare {type:"string"} is what made every field render the placeholder
  // 示例值 — the console can generate a real value, given something to go on.
  it("translates the ontology's own type into something generatable", () => {
    const of = (type: string) =>
      probePort({ name: "probe_field", type, required: true });
    expect(of("Date").format).toBe("date");
    expect(of("DateTime").format).toBe("date-time");
    expect(of("Integer").type).toBe("integer");
    expect(of("Decimal").type).toBe("number");
    expect(of("Boolean").type).toBe("boolean");
    expect(of("String")).toEqual({ type: "string" });
  });

  it("lifts an enumerated description into examples, not into an enum", () => {
    const schema = probePort({
      name: "document_type",
      type: "String",
      description: "变更单据类型：采购申请/采购包/询价单。",
      required: true,
    });
    expect(schema.examples).toEqual(["采购申请", "采购包", "询价单"]);
    // A description documents; it is not authority to reject a value the
    // ontology never actually restricted.
    expect(schema.enum).toBeUndefined();
  });

  it("leaves prose alone rather than splitting a sentence into choices", () => {
    const schema = probePort({
      name: "note",
      type: "String",
      description: "说明：请描述本次变更的业务背景与预期结果。",
      required: false,
    });
    expect(schema.examples).toBeUndefined();
  });
});

describe("submission gates", () => {
  const model = loadStudioDomain(FIXTURE_SOURCE);
  // An external action: gates exist for the write branches that fan out from a
  // shared event, which is where the ambiguity is.
  const target = model.actions.find(
    (action) => action.implementation?.kind === "external",
  )!;

  function compileWithGate(condition?: string) {
    const overlay = loadOverlayFixture();
    if (condition) overlay.submission_gates = { [target.id]: condition };
    return compile(model, overlay, { tenant: "power-scm" }).workflow.find(
      (agent) => agent.id === target.id,
    )!;
  }

  // Branches that fan out from one event share a trigger AND a rule, so a rule
  // gate cannot tell them apart. Without a per-action gate all three
  // mutually-exclusive plans executed off a single approval.
  it("gates the whole action, ahead of everything else", () => {
    const agent = compileWithGate("input.option_type == '执行调拨'");
    const first = agent.actions[0]!;
    expect(first.name).toBe(`submission-gate:${target.id}`);
    expect(first.type).toBe("condition");
    expect(first.condition).toBe("input.option_type == '执行调拨'");
  });

  // The runtime skips a step whose dependency was skipped, and that propagates,
  // so what matters is that every later step REACHES the gate — not that each
  // one names it directly.
  it("makes every later step wait on it, so a false gate runs nothing", () => {
    const agent = compileWithGate("input.option_type == '执行调拨'");
    const gateKey = agent.actions[0]!.result_key!;
    const producer = new Map(
      agent.actions.map((step) => [step.result_key ?? step.name, step]),
    );
    const reachesGate = (step: CompiledStep, seen = new Set<string>()): boolean =>
      (step.depends_on ?? []).some((dep) => {
        if (dep === gateKey) return true;
        if (seen.has(dep)) return false;
        seen.add(dep);
        const upstream = producer.get(dep);
        return upstream ? reachesGate(upstream, seen) : false;
      });

    // Every step that WRITES or EMITS must reach the gate. `suppress-implicit-emit`
    // deliberately does not: it is a no-op decision that suppresses an emit, so
    // running it behind a closed gate changes nothing.
    const acting = agent.actions.filter((step) =>
      ["tool", "emit", "manual"].includes(step.type),
    );
    expect(acting.length).toBeGreaterThan(0);
    for (const step of acting) {
      expect(reachesGate(step)).toBe(true);
    }
  });

  it("adds nothing when the overlay declares no gate", () => {
    const agent = compileWithGate();
    expect(agent.actions[0]!.name).not.toContain("submission-gate");
  });

  // Silently ignoring a gate is worse than not supporting one: the branch it
  // was meant to stop runs, and the overlay still looks right.
  it("refuses a gate that would never be compiled", () => {
    const prompt = model.actions.find(
      (action) => action.implementation?.kind === "prompt",
    )!;
    const overlay = loadOverlayFixture();
    overlay.submission_gates = { [prompt.id]: "input.x == 'y'" };
    expect(() => compile(model, overlay, { tenant: "power-scm" })).toThrow(
      /only compiled for external actions/,
    );
    const unknown = loadOverlayFixture();
    unknown.submission_gates = { "no-such-action": "input.x == 'y'" };
    expect(() => compile(model, unknown, { tenant: "power-scm" })).toThrow(
      /unknown action/,
    );
  });
});
